BEGIN;

DO $test$
BEGIN
  IF has_function_privilege(
    'anon',
    'public.check_supabase_rate_limit_poc(text,text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon must not execute the rate-limit POC RPC';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.claim_supabase_webhook_event_poc(text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not execute the webhook POC RPC';
  END IF;
  IF has_schema_privilege('anon', 'rate_limit_poc', 'USAGE')
     OR has_schema_privilege('authenticated', 'rate_limit_poc', 'USAGE') THEN
    RAISE EXCEPTION 'user roles must not use the POC state schema';
  END IF;
  IF has_table_privilege('anon', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT')
     OR has_table_privilege('authenticated', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT') THEN
    RAISE EXCEPTION 'user roles must not read rate-limit state';
  END IF;
  IF NOT has_table_privilege('service_role', 'rate_limit_poc.supabase_rate_limit_state_poc', 'SELECT') THEN
    RAISE EXCEPTION 'service_role is missing access required by the invoker RPC';
  END IF;
END;
$test$;

SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_decision JSONB;
  v_claim TEXT;
  v_first_token UUID := '00000001-0000-4000-8000-000000000001';
  v_second_token UUID := '00000002-0000-4000-8000-000000000002';
  v_third_token UUID := '00000003-0000-4000-8000-000000000003';
  v_current_count INTEGER;
  v_expired JSONB;
  v_i INTEGER;
BEGIN
  v_decision := public.check_supabase_rate_limit_poc(
    'poc-calendar-sync', repeat('a', 64), 6, 3600
  );
  IF (v_decision ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'first request must be allowed: %', v_decision;
  END IF;

  FOR v_i IN 2..6 LOOP
    v_decision := public.check_supabase_rate_limit_poc(
      'poc-calendar-sync', repeat('a', 64), 6, 3600
    );
    IF (v_decision ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
      RAISE EXCEPTION 'request % must be allowed: %', v_i, v_decision;
    END IF;
  END LOOP;

  v_decision := public.check_supabase_rate_limit_poc(
    'poc-calendar-sync', repeat('a', 64), 6, 3600
  );
  IF (v_decision ->> 'allowed')::BOOLEAN IS NOT FALSE
     OR (v_decision ->> 'retry_after_seconds')::INTEGER <= 0 THEN
    RAISE EXCEPTION 'request over the limit must be denied with a retry time: %', v_decision;
  END IF;
  SELECT state.current_count INTO v_current_count
  FROM rate_limit_poc.supabase_rate_limit_state_poc AS state
  WHERE state.scope = 'poc-calendar-sync'
    AND state.identifier_hash = repeat('a', 64)
    AND state.limit_count = 6
    AND state.window_seconds = 3600;
  IF v_current_count <> 6 THEN
    RAISE EXCEPTION 'denied requests must not increment the bucket; got %', v_current_count;
  END IF;

  v_claim := public.claim_supabase_webhook_event_poc(repeat('b', 64), v_first_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'first event claim failed: %', v_claim; END IF;
  v_claim := public.claim_supabase_webhook_event_poc(repeat('b', 64), v_second_token);
  IF v_claim <> 'in_progress' THEN RAISE EXCEPTION 'concurrent duplicate was not held: %', v_claim; END IF;
  IF public.complete_supabase_webhook_event_poc(repeat('b', 64), v_second_token) THEN
    RAISE EXCEPTION 'a non-owner must not complete a claim';
  END IF;
  IF NOT public.complete_supabase_webhook_event_poc(repeat('b', 64), v_first_token) THEN
    RAISE EXCEPTION 'claim owner could not complete the event';
  END IF;
  v_claim := public.claim_supabase_webhook_event_poc(repeat('b', 64), v_second_token);
  IF v_claim <> 'already_processed' THEN
    RAISE EXCEPTION 'completed event was not deduplicated: %', v_claim;
  END IF;

  v_claim := public.claim_supabase_webhook_event_poc(repeat('c', 64), v_first_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'release fixture claim failed: %', v_claim; END IF;
  IF public.release_supabase_webhook_event_poc(repeat('c', 64), v_second_token) THEN
    RAISE EXCEPTION 'a non-owner must not release a claim';
  END IF;
  IF NOT public.release_supabase_webhook_event_poc(repeat('c', 64), v_first_token) THEN
    RAISE EXCEPTION 'claim owner could not release a failed attempt';
  END IF;
  v_claim := public.claim_supabase_webhook_event_poc(repeat('c', 64), v_second_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'released event could not be retried: %', v_claim; END IF;

  v_claim := public.claim_supabase_webhook_event_poc(repeat('d', 64), v_first_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'lease-expiry fixture claim failed: %', v_claim; END IF;
  v_claim := public.claim_supabase_webhook_event_poc(repeat('b', 64), v_third_token);
  IF v_claim <> 'already_processed' THEN
    RAISE EXCEPTION 'completed event was not deduplicated: %', v_claim;
  END IF;
  RAISE NOTICE 'PASS rate-limit boundary, duplicate event, processing lease, completion and release';
END;
$test$;

-- Model natural expiry without sleeping for the one-hour window or five-minute lease.
RESET ROLE;
UPDATE rate_limit_poc.supabase_webhook_claims_poc
SET lease_expires_at = clock_timestamp() - INTERVAL '1 second',
    expires_at = clock_timestamp() - INTERVAL '1 second'
WHERE event_hash = repeat('d', 64);
UPDATE rate_limit_poc.supabase_webhook_claims_poc
SET processed_until = clock_timestamp() - INTERVAL '1 second',
    expires_at = clock_timestamp() - INTERVAL '1 second'
WHERE event_hash = repeat('b', 64);
UPDATE rate_limit_poc.supabase_rate_limit_state_poc
SET window_start = clock_timestamp() - INTERVAL '3 hours',
    previous_count = 4,
    current_count = 6,
    expires_at = clock_timestamp() - INTERVAL '1 second'
WHERE scope = 'poc-calendar-sync'
  AND identifier_hash = repeat('a', 64)
  AND limit_count = 6
  AND window_seconds = 3600;
INSERT INTO rate_limit_poc.supabase_rate_limit_state_poc (
  scope, identifier_hash, limit_count, window_seconds, window_start,
  previous_count, current_count, expires_at, updated_at
) VALUES (
  'poc-expired', repeat('f', 64), 1, 3600,
  clock_timestamp() - INTERVAL '3 hours', 0, 1,
  clock_timestamp() - INTERVAL '1 second', clock_timestamp()
);
INSERT INTO rate_limit_poc.supabase_webhook_claims_poc (
  event_hash, state, processing_token, lease_expires_at, processed_until, expires_at, updated_at
) VALUES (
  repeat('f', 64), 'processed', NULL, NULL,
  clock_timestamp() - INTERVAL '1 second',
  clock_timestamp() - INTERVAL '1 second', clock_timestamp()
);

SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_decision JSONB;
  v_claim TEXT;
  v_expired JSONB;
  v_first_token UUID := '00000001-0000-4000-8000-000000000001';
  v_second_token UUID := '00000002-0000-4000-8000-000000000002';
  v_third_token UUID := '00000003-0000-4000-8000-000000000003';
BEGIN
  v_claim := public.claim_supabase_webhook_event_poc(repeat('d', 64), v_second_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'expired lease was not reclaimed: %', v_claim; END IF;
  IF public.complete_supabase_webhook_event_poc(repeat('d', 64), v_first_token) THEN
    RAISE EXCEPTION 'expired owner completed a lease after another claim took over';
  END IF;
  IF NOT public.complete_supabase_webhook_event_poc(repeat('d', 64), v_second_token) THEN
    RAISE EXCEPTION 'new lease owner could not complete after takeover';
  END IF;

  v_decision := public.check_supabase_rate_limit_poc(
    'poc-calendar-sync', repeat('a', 64), 6, 3600
  );
  IF (v_decision ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'expired rate-limit window did not reset: %', v_decision;
  END IF;
  v_claim := public.claim_supabase_webhook_event_poc(repeat('b', 64), v_third_token);
  IF v_claim <> 'claimed' THEN RAISE EXCEPTION 'expired processed marker was not reclaimed: %', v_claim; END IF;

  v_expired := public.prune_supabase_rate_limit_poc(500);
  IF (v_expired ->> 'rate_limit_rows_deleted')::INTEGER < 1
     OR (v_expired ->> 'webhook_rows_deleted')::INTEGER < 1 THEN
    RAISE EXCEPTION 'bounded cleanup did not remove expired rows: %', v_expired;
  END IF;

  BEGIN
    PERFORM public.check_supabase_rate_limit_poc('bad scope with spaces', repeat('a', 64), 6, 60);
    RAISE EXCEPTION 'invalid scope was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  RAISE NOTICE 'PASS expired bucket reset, stale lease takeover, processed marker expiry, and bounded cleanup';
END;
$test$;

ROLLBACK;
