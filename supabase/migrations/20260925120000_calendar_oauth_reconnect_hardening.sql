-- Keep the OAuth claim window usable for the lifetime of its browser cookie and clear stale sync failures on reconnect.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.begin_calendar_oauth_attempt_v1(
  p_project_key TEXT,
  p_user_id UUID,
  p_state_digest BYTEA,
  p_verifier_digest BYTEA
)
RETURNS TABLE (
  attempt_id UUID,
  operation_id UUID,
  connection_id UUID,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  v_data_generation BIGINT;
  v_project_fence_id UUID;
  v_project_epoch BIGINT;
  v_now CONSTANT TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();

  IF p_user_id IS NULL
    OR p_state_digest IS NULL
    OR pg_catalog.octet_length(p_state_digest) <> 32
    OR p_verifier_digest IS NULL
    OR pg_catalog.octet_length(p_verifier_digest) <> 32 THEN
    RAISE EXCEPTION 'Calendar OAuth attempt input is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_timeblock_user_write_shared_v1(p_user_id);
  PERFORM private.assert_calendar_account_not_deleting_v1(p_user_id);
  v_data_generation := private.get_user_data_generation_v1(p_user_id);
  v_project_fence_id :=
    private.resolve_calendar_authority_project_fence_v1(p_project_key);

  SELECT fence.epoch
  INTO v_project_epoch
  FROM private.calendar_authority_fences AS fence
  WHERE fence.id = v_project_fence_id
  FOR UPDATE;

  attempt_id := gen_random_uuid();
  operation_id := gen_random_uuid();
  connection_id := gen_random_uuid();
  expires_at := v_now + INTERVAL '13 minutes';

  INSERT INTO private.calendar_oauth_attempts (
    id,
    project_fence_id,
    user_id,
    state_digest,
    verifier_digest,
    operation_id,
    connection_id,
    data_generation,
    project_epoch,
    created_at,
    expires_at,
    delete_after
  ) VALUES (
    attempt_id,
    v_project_fence_id,
    p_user_id,
    p_state_digest,
    p_verifier_digest,
    operation_id,
    connection_id,
    v_data_generation,
    v_project_epoch,
    v_now,
    expires_at,
    v_now + INTERVAL '24 hours'
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_calendar_oauth_attempt_v1(TEXT, UUID, BYTEA, BYTEA)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_calendar_oauth_attempt_v1(TEXT, UUID, BYTEA, BYTEA)
  TO service_role;

COMMENT ON FUNCTION public.begin_calendar_oauth_attempt_v1(TEXT, UUID, BYTEA, BYTEA) IS
  'Stores one server-side Google OAuth state/PKCE attempt with a 13-minute expiry so the ten-minute connect cookie retains the two-minute claim budget; service role only.';

CREATE OR REPLACE FUNCTION public.save_calendar_connection_command_v2(
  p_attempt_id UUID,
  p_project_key TEXT,
  p_user_id UUID,
  p_provider TEXT,
  p_provider_account_id TEXT,
  p_provider_account_email TEXT,
  p_granted_scopes TEXT[],
  p_refresh_token_enc TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  v_attempt private.calendar_oauth_attempts%ROWTYPE;
  v_current_generation BIGINT;
  v_project_fence_id UUID;
  v_project_epoch BIGINT;
  v_quarantine_state TEXT;
  v_quarantine_ready_after_project_epoch BIGINT;
  v_subject_fence_id UUID;
  v_subject_epoch BIGINT;
  v_subject_state TEXT;
  v_subject_ready_after_project_epoch BIGINT;
  v_resource_connection_id UUID;
  v_existing_receipt private.calendar_authority_command_receipts%ROWTYPE;
  v_existing_operation private.calendar_revoke_operations%ROWTYPE;
  v_begin RECORD;
  v_request_digest BYTEA;
  v_now CONSTANT TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();

  IF p_attempt_id IS NULL
    OR p_user_id IS NULL
    OR p_provider IS DISTINCT FROM 'google'
    OR NULLIF(pg_catalog.btrim(p_provider_account_id), '') IS NULL
    OR p_provider_account_id IS DISTINCT FROM pg_catalog.btrim(p_provider_account_id)
    OR pg_catalog.length(p_provider_account_id) > 255
    OR NULLIF(pg_catalog.btrim(p_refresh_token_enc), '') IS NULL
    OR COALESCE(pg_catalog.cardinality(p_granted_scopes), 0) = 0
    OR pg_catalog.array_position(p_granted_scopes, NULL::TEXT) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid Calendar connection input'
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

  SELECT attempt.*
  INTO v_attempt
  FROM private.calendar_oauth_attempts AS attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.project_fence_id = v_project_fence_id
    AND attempt.user_id = p_user_id
    AND attempt.claimed_at IS NOT NULL
    AND (
      attempt.completed_at IS NOT NULL
      OR (
        attempt.expires_at > v_now
        AND attempt.claim_expires_at > v_now
      )
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Calendar OAuth attempt is unavailable'
      USING ERRCODE = 'CA016';
  END IF;

  IF v_attempt.project_epoch > v_project_epoch THEN
    RAISE EXCEPTION 'Calendar OAuth project epoch is invalid'
      USING ERRCODE = 'CA012';
  END IF;

  v_request_digest := private.digest_calendar_authority_operation_v1(
    'connection_save',
    pg_catalog.jsonb_build_object(
      'operationId', v_attempt.operation_id,
      'connectionId', v_attempt.connection_id,
      'projectKey', p_project_key,
      'userId', p_user_id,
      'expectedGeneration', v_attempt.data_generation,
      'expectedProjectEpoch', v_attempt.project_epoch,
      'provider', p_provider,
      'providerAccountId', p_provider_account_id,
      'providerAccountEmail', p_provider_account_email,
      'grantedScopes', p_granted_scopes,
      'refreshTokenCiphertext', p_refresh_token_enc
    )
  );

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

  v_subject_fence_id :=
    private.get_or_create_calendar_subject_fence_v1(
      p_project_key,
      p_provider_account_id
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

  SELECT receipt.*
  INTO v_existing_receipt
  FROM private.calendar_authority_command_receipts AS receipt
  WHERE receipt.operation_id = v_attempt.operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_receipt.command_kind IS DISTINCT FROM 'connection_save'
      OR v_existing_receipt.project_fence_id IS DISTINCT FROM v_project_fence_id
      OR v_existing_receipt.subject_fence_id IS DISTINCT FROM v_subject_fence_id
      OR v_existing_receipt.source_user_id IS DISTINCT FROM p_user_id
      OR v_existing_receipt.source_connection_id IS DISTINCT FROM v_attempt.connection_id
      OR v_existing_receipt.request_digest IS DISTINCT FROM v_request_digest
      OR v_existing_receipt.result IS DISTINCT FROM 'saved' THEN
      RAISE EXCEPTION 'Calendar authority operation was reused'
        USING ERRCODE = 'CA004';
    END IF;

    RETURN 'saved';
  END IF;

  SELECT operation.*
  INTO v_existing_operation
  FROM private.calendar_revoke_operations AS operation
  WHERE operation.operation_id = v_attempt.operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_operation.project_fence_id IS DISTINCT FROM v_project_fence_id
      OR v_existing_operation.subject_fence_id IS DISTINCT FROM v_subject_fence_id
      OR v_existing_operation.source_user_id IS DISTINCT FROM p_user_id
      OR v_existing_operation.source_connection_id IS DISTINCT FROM v_attempt.connection_id
      OR v_existing_operation.operation_kind IS DISTINCT FROM 'connection_save'
      OR v_existing_operation.request_digest IS DISTINCT FROM v_request_digest THEN
      RAISE EXCEPTION 'Calendar authority operation was reused'
        USING ERRCODE = 'CA004';
    END IF;

    RETURN 'enqueued';
  END IF;

  IF v_attempt.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Calendar OAuth attempt completion invariant failed'
      USING ERRCODE = 'CA012';
  END IF;

  IF v_current_generation IS DISTINCT FROM v_attempt.data_generation
    OR v_subject_state IS DISTINCT FROM 'ready'
    OR v_quarantine_state IS DISTINCT FROM 'ready'
    OR v_attempt.project_epoch < v_subject_ready_after_project_epoch
    OR v_attempt.project_epoch < v_quarantine_ready_after_project_epoch THEN
    SELECT *
    INTO v_begin
    FROM private.begin_calendar_revoke_operation_v1(
      v_attempt.operation_id,
      v_project_fence_id,
      v_subject_fence_id,
      p_user_id,
      v_attempt.connection_id,
      'connection_save',
      v_request_digest,
      'enqueued',
      v_now + INTERVAL '23 hours 59 minutes'
    );

    IF NOT v_begin.replayed THEN
      INSERT INTO private.calendar_revoke_outbox (
        id,
        user_id,
        source_connection_id,
        provider,
        refresh_token_enc,
        created_at,
        expires_at,
        authority_fence_id,
        authority_epoch
      ) VALUES (
        v_attempt.operation_id,
        p_user_id,
        v_attempt.connection_id,
        p_provider,
        p_refresh_token_enc,
        v_now,
        v_now + INTERVAL '23 hours 59 minutes',
        v_subject_fence_id,
        v_begin.operation_subject_epoch
      );
    END IF;

    UPDATE private.calendar_oauth_attempts AS attempt
    SET completed_at = v_now,
        result = 'enqueued'
    WHERE attempt.id = v_attempt.id;

    RETURN 'enqueued';
  END IF;

  INSERT INTO public.calendar_connections (
    id,
    user_id,
    provider,
    provider_account_id,
    provider_account_email,
    granted_scopes,
    refresh_token_enc,
    status,
    last_sync_error,
    data_generation,
    authority_fence_id,
    authority_epoch,
    refresh_token_rotation_operation_id
  ) VALUES (
    v_attempt.connection_id,
    p_user_id,
    p_provider,
    p_provider_account_id,
    p_provider_account_email,
    p_granted_scopes,
    p_refresh_token_enc,
    'active',
    NULL,
    v_current_generation,
    v_subject_fence_id,
    v_subject_epoch,
    NULL
  )
  ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE
  SET provider_account_email = EXCLUDED.provider_account_email,
      granted_scopes = EXCLUDED.granted_scopes,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      status = 'active',
      last_sync_error = NULL,
      data_generation = EXCLUDED.data_generation,
      authority_fence_id = EXCLUDED.authority_fence_id,
      authority_epoch = EXCLUDED.authority_epoch,
      sync_sequence = calendar_connections.sync_sequence + 1,
      refresh_token_rotation_operation_id = NULL,
      consecutive_failures = 0
  RETURNING id INTO v_resource_connection_id;

  INSERT INTO private.calendar_authority_command_receipts (
    operation_id,
    command_kind,
    project_fence_id,
    subject_fence_id,
    source_user_id,
    source_connection_id,
    resource_connection_id,
    request_digest,
    result,
    created_at,
    delete_after
  ) VALUES (
    v_attempt.operation_id,
    'connection_save',
    v_project_fence_id,
    v_subject_fence_id,
    p_user_id,
    v_attempt.connection_id,
    v_resource_connection_id,
    v_request_digest,
    'saved',
    v_now,
    v_now + INTERVAL '90 days'
  );

  UPDATE private.calendar_oauth_attempts AS attempt
  SET completed_at = v_now,
      result = 'saved'
  WHERE attempt.id = v_attempt.id;

  RETURN 'saved';
END;
$$;

REVOKE ALL ON FUNCTION public.save_calendar_connection_command_v2(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_calendar_connection_command_v2(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT
) TO service_role;

COMMENT ON FUNCTION public.save_calendar_connection_command_v2(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT
) IS
  'Consumes one trusted OAuth attempt and immutably records either a generation/watermark-bound save or a stale-token revoke; service role only.';

COMMIT;
