-- Isolated validation DB only. Fixtures and all mutations roll back.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'dayopt_calendar_reconnect_%'
    AND coalesce(current_setting('app.isolated_validation', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Use an isolated validation database';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

DO $test$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_legacy_connection_id UUID := gen_random_uuid();
  v_repair_connection_id UUID := gen_random_uuid();
  v_stale_connection_id UUID := gen_random_uuid();
  v_deleted_connection_id UUID := gen_random_uuid();
  v_attempt_id UUID;
  v_state_digest BYTEA := decode(repeat('01', 32), 'hex');
  v_verifier_digest BYTEA := decode(repeat('02', 32), 'hex');
  v_fence_id UUID;
  v_epoch BIGINT;
  v_status TEXT;
  v_failures INTEGER;
  v_result TEXT;
BEGIN
  INSERT INTO auth.users(id, email, raw_user_meta_data)
  VALUES (v_user_id, v_user_id::TEXT || '@example.invalid', '{}'::JSONB);

  PERFORM public.provision_calendar_authority_project_v1(
    '123456789',
    '123456789-calendar-reconnect-test.apps.googleusercontent.com'
  );
  UPDATE private.calendar_authority_projects
  SET activation_version = 1,
      activated_at = pg_catalog.clock_timestamp()
  WHERE singleton
    AND project_key = '123456789'
    AND activation_version = 0
    AND activated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Test Calendar authority project was not provisioned';
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
    consecutive_failures
  ) VALUES (
    v_legacy_connection_id,
    v_user_id,
    'google',
    'legacy-active-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'old-ciphertext',
    'active',
    3
  );

  SELECT attempt.attempt_id
  INTO v_attempt_id
  FROM public.begin_calendar_oauth_attempt_v1(
    '123456789', v_user_id, v_state_digest, v_verifier_digest
  ) AS attempt;
  PERFORM 1
  FROM public.claim_calendar_oauth_attempt_v1(
    '123456789', v_user_id, v_state_digest, v_verifier_digest
  ) AS claim
  WHERE claim.attempt_id = v_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth attempt was not claimed'; END IF;

  SELECT public.reconnect_calendar_connection_command_v1(
    v_attempt_id,
    '123456789',
    v_user_id,
    v_legacy_connection_id,
    'google',
    'legacy-active-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'new-ciphertext'
  ) INTO v_result;
  IF v_result IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'Legacy active reconnect returned %', v_result;
  END IF;

  SELECT authority_fence_id, authority_epoch, status, consecutive_failures
  INTO v_fence_id, v_epoch, v_status, v_failures
  FROM public.calendar_connections
  WHERE id = v_legacy_connection_id AND user_id = v_user_id;
  IF v_fence_id IS NULL OR v_epoch IS NULL OR v_status <> 'active' OR v_failures <> 0 THEN
    RAISE EXCEPTION 'Legacy active reconnect did not restore its authority fence';
  END IF;

  INSERT INTO public.calendar_connections (
    id,
    user_id,
    provider,
    provider_account_id,
    provider_account_email,
    granted_scopes,
    refresh_token_enc,
    status
  ) VALUES (
    v_repair_connection_id,
    v_user_id,
    'google',
    'repair-active-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'legacy-ciphertext',
    'active'
  );

  SELECT public.repair_calendar_connection_authority_fence_v1(
    '123456789', v_user_id, v_repair_connection_id
  ) INTO v_result;
  IF v_result IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Current-generation legacy fence repair returned %', v_result;
  END IF;
  SELECT authority_fence_id, authority_epoch
  INTO v_fence_id, v_epoch
  FROM public.calendar_connections
  WHERE id = v_repair_connection_id AND user_id = v_user_id;
  IF v_fence_id IS NULL OR v_epoch IS NULL THEN
    RAISE EXCEPTION 'Current-generation legacy connection was not fenced';
  END IF;
  SELECT public.repair_calendar_connection_authority_fence_v1(
    '123456789', v_user_id, v_repair_connection_id
  ) INTO v_result;
  IF v_result IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Idempotent fence repair returned %', v_result;
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
    data_generation
  ) VALUES (
    v_stale_connection_id,
    v_user_id,
    'google',
    'stale-repair-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'stale-ciphertext',
    'active',
    1
  );

  SELECT public.repair_calendar_connection_authority_fence_v1(
    '123456789', v_user_id, v_stale_connection_id
  ) INTO v_result;
  IF v_result IS DISTINCT FROM 'stale' THEN
    RAISE EXCEPTION 'Stale-generation fence repair returned %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.calendar_connections
    WHERE id = v_stale_connection_id
      AND (authority_fence_id IS NOT NULL OR authority_epoch IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Stale-generation connection was promoted to a ready fence';
  END IF;

  INSERT INTO public.calendar_connections (
    id,
    user_id,
    provider,
    provider_account_id,
    provider_account_email,
    granted_scopes,
    refresh_token_enc,
    status
  ) VALUES (
    v_deleted_connection_id,
    v_user_id,
    'google',
    'deleted-active-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'old-ciphertext',
    'active'
  );

  v_state_digest := decode(repeat('03', 32), 'hex');
  v_verifier_digest := decode(repeat('04', 32), 'hex');
  SELECT attempt.attempt_id
  INTO v_attempt_id
  FROM public.begin_calendar_oauth_attempt_v1(
    '123456789', v_user_id, v_state_digest, v_verifier_digest
  ) AS attempt;
  PERFORM 1
  FROM public.claim_calendar_oauth_attempt_v1(
    '123456789', v_user_id, v_state_digest, v_verifier_digest
  ) AS claim
  WHERE claim.attempt_id = v_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Second OAuth attempt was not claimed'; END IF;

  DELETE FROM public.calendar_connections
  WHERE id = v_deleted_connection_id AND user_id = v_user_id;

  SELECT public.reconnect_calendar_connection_command_v1(
    v_attempt_id,
    '123456789',
    v_user_id,
    v_deleted_connection_id,
    'google',
    'deleted-active-subject',
    'owner@example.invalid',
    ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'],
    'new-ciphertext'
  ) INTO v_result;
  IF v_result IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'Deleted reconnect target returned %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.calendar_connections
    WHERE id = v_deleted_connection_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Reconnect recreated a connection removed during OAuth';
  END IF;
END;
$test$;
ROLLBACK;
