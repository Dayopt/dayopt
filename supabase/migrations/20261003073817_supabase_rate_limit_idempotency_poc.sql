-- Reversible proof of concept. Runtime adapters remain disabled outside an explicit Integration opt-in.
-- State is isolated in an unexposed schema; only service_role may invoke the RPCs.

CREATE SCHEMA rate_limit_poc;
REVOKE ALL ON SCHEMA rate_limit_poc FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA rate_limit_poc TO service_role;

CREATE TABLE rate_limit_poc.supabase_rate_limit_state_poc (
  scope TEXT NOT NULL CHECK (scope ~ '^[a-z][a-z0-9:_-]{0,63}$'),
  identifier_hash TEXT NOT NULL CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 10000),
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  window_start TIMESTAMPTZ NOT NULL,
  previous_count INTEGER NOT NULL CHECK (previous_count >= 0),
  current_count INTEGER NOT NULL CHECK (current_count >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, identifier_hash, limit_count, window_seconds)
);

CREATE INDEX supabase_rate_limit_state_poc_expires_at_idx
  ON rate_limit_poc.supabase_rate_limit_state_poc (expires_at);

ALTER TABLE rate_limit_poc.supabase_rate_limit_state_poc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rate_limit_poc.supabase_rate_limit_state_poc FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rate_limit_poc.supabase_rate_limit_state_poc TO service_role;

COMMENT ON TABLE rate_limit_poc.supabase_rate_limit_state_poc IS
  'POC only: hashed sliding-window counters for server-side rate limits. Remove after decision.';

CREATE TABLE rate_limit_poc.supabase_webhook_claims_poc (
  event_hash TEXT PRIMARY KEY CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('processing', 'processed')),
  processing_token UUID,
  lease_expires_at TIMESTAMPTZ,
  processed_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (state = 'processing' AND processing_token IS NOT NULL AND lease_expires_at IS NOT NULL AND processed_until IS NULL)
    OR
    (state = 'processed' AND processing_token IS NULL AND lease_expires_at IS NULL AND processed_until IS NOT NULL)
  )
);

CREATE INDEX supabase_webhook_claims_poc_expires_at_idx
  ON rate_limit_poc.supabase_webhook_claims_poc (expires_at);

ALTER TABLE rate_limit_poc.supabase_webhook_claims_poc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rate_limit_poc.supabase_webhook_claims_poc FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rate_limit_poc.supabase_webhook_claims_poc TO service_role;

COMMENT ON TABLE rate_limit_poc.supabase_webhook_claims_poc IS
  'POC only: lease and deduplication state for signed email-provider webhook event IDs.';

CREATE OR REPLACE FUNCTION public.check_supabase_rate_limit_poc(
  p_scope TEXT,
  p_identifier_hash TEXT,
  p_limit_count INTEGER,
  p_window_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '1500ms'
SET statement_timeout = '2000ms'
AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_window_start TIMESTAMPTZ;
  v_window INTERVAL;
  v_stored_window_start TIMESTAMPTZ;
  v_stored_previous_count INTEGER := 0;
  v_stored_current_count INTEGER := 0;
  v_current_count INTEGER;
  v_previous_count INTEGER;
  v_weighted_previous_count INTEGER;
  v_weighted_count INTEGER;
  v_retry_at TIMESTAMPTZ;
  v_progress NUMERIC;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[a-z][a-z0-9:_-]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid rate-limit scope' USING ERRCODE = '22023';
  END IF;
  IF p_identifier_hash IS NULL OR p_identifier_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Identifier must be a lowercase SHA-256/HMAC hex digest' USING ERRCODE = '22023';
  END IF;
  IF p_limit_count IS NULL OR p_limit_count NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid rate-limit budget' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'Invalid rate-limit window' USING ERRCODE = '22023';
  END IF;

  -- Serialize one hashed identity/scope. Hash collisions only cause extra waiting;
  -- the table's composite primary key remains the source of state identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dayopt:rate-limit-poc:' || p_scope || ':' || p_identifier_hash, 0)
  );

  -- Read the clock after acquiring the lock so a long waiter cannot use an old window.
  v_now := pg_catalog.clock_timestamp();
  v_window := pg_catalog.make_interval(secs => p_window_seconds::DOUBLE PRECISION);
  v_window_start := pg_catalog.date_bin(v_window, v_now, TIMESTAMPTZ '1970-01-01 00:00:00+00');

  SELECT state.window_start, state.previous_count, state.current_count
  INTO v_stored_window_start, v_stored_previous_count, v_stored_current_count
  FROM rate_limit_poc.supabase_rate_limit_state_poc AS state
  WHERE state.scope = p_scope
    AND state.identifier_hash = p_identifier_hash
    AND state.limit_count = p_limit_count
    AND state.window_seconds = p_window_seconds
  FOR UPDATE;

  IF FOUND THEN
    IF v_stored_window_start = v_window_start THEN
      v_previous_count := v_stored_previous_count;
      v_current_count := v_stored_current_count;
    ELSIF v_stored_window_start = v_window_start - v_window THEN
      v_previous_count := v_stored_current_count;
      v_current_count := 0;
    ELSE
      v_previous_count := 0;
      v_current_count := 0;
    END IF;
  ELSE
    v_previous_count := 0;
    v_current_count := 0;
  END IF;

  v_progress := EXTRACT(EPOCH FROM (v_now - v_window_start))::NUMERIC / p_window_seconds::NUMERIC;
  v_weighted_previous_count := FLOOR(
    v_previous_count::NUMERIC * GREATEST(0::NUMERIC, 1::NUMERIC - v_progress)
  )::INTEGER;
  v_weighted_count := v_current_count + v_weighted_previous_count;

  -- Match @upstash/ratelimit's sliding-window contract: denied requests do not
  -- increment the current bucket; the previous bucket contribution rounds down.
  IF v_weighted_count >= p_limit_count THEN
    IF v_current_count < p_limit_count THEN
      v_retry_at := v_window_start
        + pg_catalog.make_interval(
          secs => (p_window_seconds::NUMERIC
            * (1::NUMERIC - ((p_limit_count - v_current_count)::NUMERIC / v_previous_count::NUMERIC)))::DOUBLE PRECISION
        )
        + INTERVAL '1 millisecond';
    ELSE
      v_retry_at := v_window_start + v_window
        + pg_catalog.make_interval(
          secs => (p_window_seconds::NUMERIC
            * (1::NUMERIC - (p_limit_count::NUMERIC / v_current_count::NUMERIC)))::DOUBLE PRECISION
        )
        + INTERVAL '1 millisecond';
    END IF;

    IF v_retry_at <= v_now THEN
      v_retry_at := v_now + INTERVAL '1 millisecond';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'allowed', FALSE,
      'remaining', 0,
      'estimated_count', v_weighted_count,
      'reset_at', v_retry_at,
      'retry_after_seconds', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_retry_at - v_now)))::INTEGER)
    );
  END IF;

  v_current_count := v_current_count + 1;
  v_weighted_count := v_weighted_count + 1;

  INSERT INTO rate_limit_poc.supabase_rate_limit_state_poc AS saved (
    scope,
    identifier_hash,
    limit_count,
    window_seconds,
    window_start,
    previous_count,
    current_count,
    expires_at,
    updated_at
  )
  VALUES (
    p_scope,
    p_identifier_hash,
    p_limit_count,
    p_window_seconds,
    v_window_start,
    v_previous_count,
    v_current_count,
    v_window_start + v_window + v_window + INTERVAL '1 second',
    v_now
  )
  ON CONFLICT (scope, identifier_hash, limit_count, window_seconds) DO UPDATE
  SET
    previous_count = EXCLUDED.previous_count,
    current_count = EXCLUDED.current_count,
    window_start = EXCLUDED.window_start,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at;

  v_retry_at := v_window_start + v_window;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', TRUE,
    'remaining', GREATEST(0, p_limit_count - v_weighted_count),
    'estimated_count', v_weighted_count,
    'reset_at', v_retry_at,
    'retry_after_seconds', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_supabase_rate_limit_poc(TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_supabase_rate_limit_poc(TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_supabase_webhook_event_poc(
  p_event_hash TEXT,
  p_processing_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '1500ms'
SET statement_timeout = '2000ms'
AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_state TEXT;
  v_token UUID;
  v_lease_expires_at TIMESTAMPTZ;
  v_processed_until TIMESTAMPTZ;
BEGIN
  IF p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Event ID must be a lowercase SHA-256/HMAC hex digest' USING ERRCODE = '22023';
  END IF;
  IF p_processing_token IS NULL THEN
    RAISE EXCEPTION 'Processing token is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dayopt:webhook-poc:' || p_event_hash, 0)
  );
  v_now := pg_catalog.clock_timestamp();

  SELECT event.state, event.processing_token, event.lease_expires_at, event.processed_until
  INTO v_state, v_token, v_lease_expires_at, v_processed_until
  FROM rate_limit_poc.supabase_webhook_claims_poc AS event
  WHERE event.event_hash = p_event_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO rate_limit_poc.supabase_webhook_claims_poc (
      event_hash, state, processing_token, lease_expires_at, processed_until, expires_at, updated_at
    ) VALUES (
      p_event_hash, 'processing', p_processing_token, v_now + INTERVAL '5 minutes', NULL,
      v_now + INTERVAL '5 minutes', v_now
    );
    RETURN 'claimed';
  END IF;

  IF v_state = 'processed' AND v_processed_until > v_now THEN
    RETURN 'already_processed';
  END IF;
  IF v_state = 'processing' AND v_lease_expires_at > v_now THEN
    RETURN 'in_progress';
  END IF;

  UPDATE rate_limit_poc.supabase_webhook_claims_poc AS event
  SET state = 'processing',
      processing_token = p_processing_token,
      lease_expires_at = v_now + INTERVAL '5 minutes',
      processed_until = NULL,
      expires_at = v_now + INTERVAL '5 minutes',
      updated_at = v_now
  WHERE event.event_hash = p_event_hash;
  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_supabase_webhook_event_poc(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_supabase_webhook_event_poc(TEXT, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_supabase_webhook_event_poc(
  p_event_hash TEXT,
  p_processing_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '1500ms'
SET statement_timeout = '2000ms'
AS $$
DECLARE
  v_now TIMESTAMPTZ;
BEGIN
  IF p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$' OR p_processing_token IS NULL THEN
    RAISE EXCEPTION 'Event digest and processing token are required' USING ERRCODE = '22023';
  END IF;
  v_now := pg_catalog.clock_timestamp();

  UPDATE rate_limit_poc.supabase_webhook_claims_poc AS event
  SET state = 'processed',
      processing_token = NULL,
      lease_expires_at = NULL,
      processed_until = v_now + INTERVAL '35 days',
      expires_at = v_now + INTERVAL '35 days',
      updated_at = v_now
  WHERE event.event_hash = p_event_hash
    AND event.state = 'processing'
    AND event.processing_token = p_processing_token
    AND event.lease_expires_at > v_now;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_supabase_webhook_event_poc(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_supabase_webhook_event_poc(TEXT, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_supabase_webhook_event_poc(
  p_event_hash TEXT,
  p_processing_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '1500ms'
SET statement_timeout = '2000ms'
AS $$
BEGIN
  IF p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$' OR p_processing_token IS NULL THEN
    RAISE EXCEPTION 'Event digest and processing token are required' USING ERRCODE = '22023';
  END IF;

  DELETE FROM rate_limit_poc.supabase_webhook_claims_poc AS event
  WHERE event.event_hash = p_event_hash
    AND event.state = 'processing'
    AND event.processing_token = p_processing_token;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.release_supabase_webhook_event_poc(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_supabase_webhook_event_poc(TEXT, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.prune_supabase_rate_limit_poc(p_batch_size INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '5000ms'
AS $$
DECLARE
  v_rate_limit_rows INTEGER;
  v_webhook_rows INTEGER;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 5000' USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT state.ctid
    FROM rate_limit_poc.supabase_rate_limit_state_poc AS state
    WHERE state.expires_at <= pg_catalog.clock_timestamp()
    ORDER BY state.expires_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM rate_limit_poc.supabase_rate_limit_state_poc AS state
    USING expired
    WHERE state.ctid = expired.ctid
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_rate_limit_rows FROM deleted;

  WITH expired AS (
    SELECT event.ctid
    FROM rate_limit_poc.supabase_webhook_claims_poc AS event
    WHERE event.expires_at <= pg_catalog.clock_timestamp()
    ORDER BY event.expires_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM rate_limit_poc.supabase_webhook_claims_poc AS event
    USING expired
    WHERE event.ctid = expired.ctid
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_webhook_rows FROM deleted;

  RETURN pg_catalog.jsonb_build_object(
    'rate_limit_rows_deleted', v_rate_limit_rows,
    'webhook_rows_deleted', v_webhook_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_supabase_rate_limit_poc(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_supabase_rate_limit_poc(INTEGER)
  TO service_role;

DO $poc_contract$
DECLARE
  v_function REGPROCEDURE;
  v_functions REGPROCEDURE[] := ARRAY[
    'public.check_supabase_rate_limit_poc(text,text,integer,integer)'::REGPROCEDURE,
    'public.claim_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
    'public.complete_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
    'public.release_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
    'public.prune_supabase_rate_limit_poc(integer)'::REGPROCEDURE
  ];
BEGIN
  IF NOT (
    SELECT table_row_security.relrowsecurity
    FROM pg_catalog.pg_class AS table_row_security
    JOIN pg_catalog.pg_namespace AS table_schema
      ON table_schema.oid = table_row_security.relnamespace
    WHERE table_schema.nspname = 'rate_limit_poc'
      AND table_row_security.relname = 'supabase_rate_limit_state_poc'
  ) OR NOT (
    SELECT table_row_security.relrowsecurity
    FROM pg_catalog.pg_class AS table_row_security
    JOIN pg_catalog.pg_namespace AS table_schema
      ON table_schema.oid = table_row_security.relnamespace
    WHERE table_schema.nspname = 'rate_limit_poc'
      AND table_row_security.relname = 'supabase_webhook_claims_poc'
  ) THEN
    RAISE EXCEPTION 'RLS must be enabled on both POC tables';
  END IF;

  IF has_schema_privilege('anon', 'rate_limit_poc', 'USAGE')
     OR has_schema_privilege('authenticated', 'rate_limit_poc', 'USAGE')
     OR has_table_privilege('anon', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT')
     OR has_table_privilege('authenticated', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT')
     OR has_table_privilege('anon', 'rate_limit_poc.supabase_webhook_claims_poc', 'SELECT')
     OR has_table_privilege('authenticated', 'rate_limit_poc.supabase_webhook_claims_poc', 'SELECT') THEN
    RAISE EXCEPTION 'User roles must not access POC state';
  END IF;

  IF NOT has_schema_privilege('service_role', 'rate_limit_poc', 'USAGE')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_rate_limit_state_poc', 'INSERT')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_rate_limit_state_poc', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_rate_limit_state_poc', 'DELETE')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_webhook_claims_poc', 'SELECT')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_webhook_claims_poc', 'INSERT')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_webhook_claims_poc', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_webhook_claims_poc', 'DELETE') THEN
    RAISE EXCEPTION 'service_role is missing the minimum table access for the invoker RPCs';
  END IF;

  FOREACH v_function IN ARRAY v_functions LOOP
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected RPC execution grants for %', v_function;
    END IF;
    IF (SELECT function_proc.prosecdef FROM pg_catalog.pg_proc AS function_proc WHERE function_proc.oid = v_function) THEN
      RAISE EXCEPTION 'POC RPC % must not run as SECURITY DEFINER', v_function;
    END IF;
  END LOOP;
END;
$poc_contract$;
