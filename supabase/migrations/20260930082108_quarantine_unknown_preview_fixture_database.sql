-- Quarantine an uncertain ephemeral DB across all run IDs.
-- This blocks future broker writes; it does not cancel in-flight Auth requests
-- or assert provider deletion. No automatic unquarantine path is exposed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION private.preview_fixture_lifecycle_v1(
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

  -- Serialize lifecycle state changes for this DB before taking run-row locks.
  -- UNKNOWN belongs to the resource: a new run ID cannot make that DB reusable.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dayopt:preview-fixture-database:' || p_database_ref, 0)
  );
  v_now := pg_catalog.clock_timestamp();
  UPDATE private.preview_fixture_lifecycle
    SET state = 'UNKNOWN', closed = TRUE, owner_id = NULL, operation = NULL,
        deadline = NULL, updated_at = v_now
    WHERE database_ref = p_database_ref AND state = 'ACTIVE' AND deadline <= v_now;
  IF EXISTS (
    SELECT 1 FROM private.preview_fixture_lifecycle
    WHERE database_ref = p_database_ref AND state = 'UNKNOWN'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unknown');
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

COMMIT;
