-- Bind a single current-generation legacy connection to its Google subject fence before
-- calendar-list or selected-calendar operations. This never falls back to an unfenced write.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.repair_calendar_connection_authority_fence_v1(
  p_project_key TEXT,
  p_user_id UUID,
  p_connection_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  v_current_generation BIGINT;
  v_project_fence_id UUID;
  v_project_epoch BIGINT;
  v_quarantine_state TEXT;
  v_quarantine_ready_after_project_epoch BIGINT;
  v_subject_fence_id UUID;
  v_subject_epoch BIGINT;
  v_subject_state TEXT;
  v_subject_ready_after_project_epoch BIGINT;
  v_provider_account_id TEXT;
  v_connection public.calendar_connections%ROWTYPE;
  v_repaired_connection_id UUID;
  v_now CONSTANT TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();

  IF p_user_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Calendar connection fence repair input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_timeblock_user_write_shared_v1(p_user_id);
  PERFORM private.assert_calendar_account_not_deleting_v1(p_user_id);
  v_current_generation := private.get_user_data_generation_v1(p_user_id);

  v_project_fence_id :=
    private.resolve_calendar_authority_project_fence_v1(p_project_key);

  SELECT project.epoch
  INTO v_project_epoch
  FROM private.calendar_authority_fences AS project
  WHERE project.id = v_project_fence_id
  FOR UPDATE;

  SELECT
    quarantine.state,
    quarantine.ready_after_project_epoch
  INTO
    v_quarantine_state,
    v_quarantine_ready_after_project_epoch
  FROM private.calendar_authority_fences AS quarantine
  WHERE quarantine.project_key = p_project_key
    AND quarantine.scope_kind = 'quarantine'
  FOR UPDATE;

  SELECT connection.*
  INTO v_connection
  FROM public.calendar_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id
    AND connection.provider = 'google';

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF v_connection.status IS DISTINCT FROM 'active' THEN
    RETURN 'blocked';
  END IF;
  IF v_connection.data_generation IS DISTINCT FROM v_current_generation THEN
    RETURN 'stale';
  END IF;
  v_provider_account_id := v_connection.provider_account_id;

  v_subject_fence_id :=
    private.get_or_create_calendar_subject_fence_v1(
      p_project_key,
      v_provider_account_id
    );

  SELECT
    subject.epoch,
    subject.state,
    subject.ready_after_project_epoch
  INTO
    v_subject_epoch,
    v_subject_state,
    v_subject_ready_after_project_epoch
  FROM private.calendar_authority_fences AS subject
  WHERE subject.id = v_subject_fence_id
  FOR UPDATE;

  IF v_project_epoch IS NULL
    OR v_subject_epoch IS NULL
    OR v_subject_state IS DISTINCT FROM 'ready'
    OR v_quarantine_state IS DISTINCT FROM 'ready'
    OR v_subject_ready_after_project_epoch > v_project_epoch
    OR v_quarantine_ready_after_project_epoch > v_project_epoch THEN
    RETURN 'blocked';
  END IF;

  SELECT connection.*
  INTO v_connection
  FROM public.calendar_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id
    AND connection.provider = 'google'
    AND connection.provider_account_id = v_provider_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF v_connection.status IS DISTINCT FROM 'active' THEN
    RETURN 'blocked';
  END IF;

  IF v_connection.data_generation IS DISTINCT FROM v_current_generation THEN
    RETURN 'stale';
  END IF;

  IF v_connection.authority_fence_id IS NOT NULL
    OR v_connection.authority_epoch IS NOT NULL THEN
    IF v_connection.authority_fence_id = v_subject_fence_id
      AND v_connection.authority_epoch = v_subject_epoch THEN
      RETURN 'ready';
    END IF;
    RETURN 'blocked';
  END IF;

  UPDATE public.calendar_connections AS connection
  SET authority_fence_id = v_subject_fence_id,
      authority_epoch = v_subject_epoch,
      sync_sequence = connection.sync_sequence + 1,
      updated_at = v_now
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id
    AND connection.provider = 'google'
    AND connection.provider_account_id = v_provider_account_id
    AND connection.status = 'active'
    AND connection.data_generation = v_current_generation
    AND connection.authority_fence_id IS NULL
    AND connection.authority_epoch IS NULL
  RETURNING connection.id INTO v_repaired_connection_id;

  IF v_repaired_connection_id IS NULL THEN
    RETURN 'blocked';
  END IF;

  RETURN 'ready';
END;
$$;

REVOKE ALL ON FUNCTION public.repair_calendar_connection_authority_fence_v1(
  TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_calendar_connection_authority_fence_v1(
  TEXT, UUID, UUID
) TO service_role;

COMMENT ON FUNCTION public.repair_calendar_connection_authority_fence_v1(
  TEXT, UUID, UUID
) IS
  'Binds one active current-generation legacy Google connection with missing authority fence to its ready subject fence; never permits an unfenced calendar operation; service role only.';

COMMIT;
