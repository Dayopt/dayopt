-- Payload-free coordination for owned ephemeral Preview fixtures only.
-- No auth FK: terminal state must survive fixture user deletion.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE private.preview_fixture_lifecycle (
  database_ref TEXT NOT NULL CHECK (database_ref ~ '^[a-z]{20}$'),
  run_id UUID NOT NULL,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN ('IDLE', 'ACTIVE', 'UNKNOWN', 'CLEANED')),
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  owner_id UUID,
  operation TEXT CHECK (operation IN ('provision', 'cleanup', 'recover')),
  deadline TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (database_ref, run_id),
  CHECK ((state = 'ACTIVE' AND owner_id IS NOT NULL AND operation IS NOT NULL AND deadline IS NOT NULL)
    OR (state <> 'ACTIVE' AND owner_id IS NULL AND operation IS NULL AND deadline IS NULL)),
  CHECK (state NOT IN ('UNKNOWN', 'CLEANED') OR closed)
);
ALTER TABLE private.preview_fixture_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.preview_fixture_lifecycle FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.preview_fixture_lifecycle_v1(
  p_database_ref TEXT, p_run_id UUID, p_intent_digest TEXT, p_owner_id UUID,
  p_action TEXT, p_operation TEXT, p_success BOOLEAN
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '15s'
AS $$
DECLARE
  v_row private.preview_fixture_lifecycle%ROWTYPE;
  v_now TIMESTAMPTZ;
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();
  IF p_database_ref IS NULL OR p_database_ref !~ '^[a-z]{20}$'
    OR p_database_ref IN ('yvglwblxrnrenfifsnje', 'tilwaprottpyhlfoggbb')
    OR p_run_id IS NULL OR p_owner_id IS NULL
    OR p_run_id = '00000000-0000-0000-0000-000000000000'::UUID
    OR p_owner_id = '00000000-0000-0000-0000-000000000000'::UUID
    OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
    OR p_action IS NULL OR p_action NOT IN ('claim', 'guard', 'finish')
    OR p_operation IS NULL OR p_operation NOT IN ('provision', 'cleanup', 'recover')
    OR (p_action = 'finish') <> (p_success IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid Preview lifecycle request' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'claim' THEN
    INSERT INTO private.preview_fixture_lifecycle (database_ref, run_id, intent_digest)
    VALUES (p_database_ref, p_run_id, p_intent_digest) ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO v_row FROM private.preview_fixture_lifecycle
    WHERE database_ref = p_database_ref AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_row.intent_digest <> p_intent_digest THEN
    RETURN pg_catalog.jsonb_build_object('status', 'denied');
  END IF;
  -- Clock is sampled after row-lock wait, not transaction start.
  v_now := pg_catalog.clock_timestamp();
  IF p_action = 'claim' AND p_operation IN ('cleanup', 'recover') THEN
    UPDATE private.preview_fixture_lifecycle SET closed = TRUE, updated_at = v_now
      WHERE database_ref = p_database_ref AND run_id = p_run_id;
    v_row.closed := TRUE;
  END IF;
  IF v_row.state = 'ACTIVE' AND v_row.deadline <= v_now THEN
    UPDATE private.preview_fixture_lifecycle
      SET state = 'UNKNOWN', closed = TRUE, owner_id = NULL, operation = NULL,
          deadline = NULL, updated_at = v_now
      WHERE database_ref = p_database_ref AND run_id = p_run_id;
    RETURN pg_catalog.jsonb_build_object('status', 'unknown');
  END IF;
  IF v_row.state = 'UNKNOWN' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unknown');
  END IF;

  IF p_action = 'claim' THEN
    IF v_row.closed AND p_operation = 'provision' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'closed');
    END IF;
    IF v_row.state = 'ACTIVE' THEN
      IF v_row.owner_id = p_owner_id AND v_row.operation = p_operation THEN
        RETURN pg_catalog.jsonb_build_object('status', 'acquired');
      END IF;
      RETURN pg_catalog.jsonb_build_object('status', 'busy');
    END IF;
    UPDATE private.preview_fixture_lifecycle
      SET state = 'ACTIVE', owner_id = p_owner_id, operation = p_operation,
          deadline = v_now + INTERVAL '180 seconds', updated_at = v_now
      WHERE database_ref = p_database_ref AND run_id = p_run_id;
    RETURN pg_catalog.jsonb_build_object('status', 'acquired');
  END IF;

  IF v_row.state <> 'ACTIVE' OR v_row.owner_id IS DISTINCT FROM p_owner_id
    OR v_row.operation IS DISTINCT FROM p_operation THEN
    RETURN pg_catalog.jsonb_build_object('status', 'denied');
  END IF;
  -- A cleanup claim closes future provision while an existing owner finishes.
  IF p_action = 'guard' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'owned');
  END IF;
  UPDATE private.preview_fixture_lifecycle
    SET state = CASE WHEN NOT p_success THEN 'UNKNOWN'
                     WHEN p_operation = 'provision' THEN 'IDLE' ELSE 'CLEANED' END,
        closed = closed OR NOT p_success OR p_operation <> 'provision',
        owner_id = NULL, operation = NULL, deadline = NULL, updated_at = v_now
    WHERE database_ref = p_database_ref AND run_id = p_run_id;
  RETURN pg_catalog.jsonb_build_object('status', CASE WHEN p_success THEN 'finished' ELSE 'unknown' END);
END;
$$;
REVOKE ALL ON FUNCTION private.preview_fixture_lifecycle_v1(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.preview_fixture_lifecycle_v1(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN)
  TO service_role;

CREATE FUNCTION public.preview_fixture_lifecycle_v1(
  p_database_ref TEXT, p_run_id UUID, p_intent_digest TEXT, p_owner_id UUID,
  p_action TEXT, p_operation TEXT, p_success BOOLEAN
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT private.preview_fixture_lifecycle_v1(
    p_database_ref, p_run_id, p_intent_digest, p_owner_id, p_action, p_operation, p_success
  );
$$;
REVOKE ALL ON FUNCTION public.preview_fixture_lifecycle_v1(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_fixture_lifecycle_v1(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN)
  TO service_role;

DO $assert$
DECLARE v_role TEXT; v_privilege TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'private.preview_fixture_lifecycle', v_privilege) THEN
        RAISE EXCEPTION 'Preview lifecycle table must remain private';
      END IF;
    END LOOP;
    IF pg_catalog.has_function_privilege(v_role,
      'public.preview_fixture_lifecycle_v1(text,uuid,text,uuid,text,text,boolean)', 'EXECUTE') <> (v_role = 'service_role')
      OR pg_catalog.has_function_privilege(v_role,
      'private.preview_fixture_lifecycle_v1(text,uuid,text,uuid,text,text,boolean)', 'EXECUTE') <> (v_role = 'service_role') THEN
      RAISE EXCEPTION 'Preview lifecycle RPC privileges differ';
    END IF;
  END LOOP;
END;
$assert$;
COMMIT;
