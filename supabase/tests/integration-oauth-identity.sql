-- Run only in the disposable CI Supabase database. Every change rolls back.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF coalesce(current_setting('app.isolated_validation', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Use an isolated validation database';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.mcp_environment_identity) THEN
    RAISE EXCEPTION 'Run before tests that provision an immutable OAuth identity';
  END IF;
END $$;
INSERT INTO public.mcp_mutation_control (
  singleton_key, writes_enabled, billing_enforced, enabled_client_ids, revision
) VALUES (true, false, false, '{}'::TEXT[], 0)
ON CONFLICT (singleton_key) DO UPDATE
SET writes_enabled = false, enabled_client_ids = '{}'::TEXT[];

-- This rollback-only Integration contract retains its historical sample email.
-- Normalize either exact seed revision inside this disposable test transaction.
DO $fixture$
DECLARE
  v_user_count BIGINT;
  v_identity_count BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS app_user
    JOIN auth.identities AS identity ON identity.user_id = app_user.id
    WHERE app_user.id = '00000000-0000-0000-0000-000000000001'::UUID
      AND app_user.email IN ('test@dayopt.dev', 'test-seed@dayopt.dev')
      AND identity.id = app_user.id
      AND identity.provider = 'email'
      AND identity.provider_id = app_user.email
      AND identity.email = app_user.email
      AND identity.identity_data = jsonb_build_object(
        'sub', app_user.id::TEXT,
        'email', app_user.email
      )
  ) THEN
    RAISE EXCEPTION 'Expected exact deterministic seed Auth tuple';
  END IF;

  UPDATE auth.users
  SET email = 'test@dayopt.dev'
  WHERE id = '00000000-0000-0000-0000-000000000001'::UUID;
  GET DIAGNOSTICS v_user_count = ROW_COUNT;
  UPDATE auth.identities
  SET provider_id = 'test@dayopt.dev',
      email = 'test@dayopt.dev',
      identity_data = jsonb_build_object(
        'sub', '00000000-0000-0000-0000-000000000001',
        'email', 'test@dayopt.dev'
      )
  WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
    AND user_id = '00000000-0000-0000-0000-000000000001'::UUID;
  GET DIAGNOSTICS v_identity_count = ROW_COUNT;
  IF v_user_count <> 1 OR v_identity_count <> 1 THEN
    RAISE EXCEPTION 'Could not normalize exact Integration test seed tuple';
  END IF;
END
$fixture$;

DO $test$
DECLARE
  v_identity RECORD;
  v_repeated RECORD;
  v_extra_user UUID := gen_random_uuid();
  v_failures TEXT[] := '{}'::TEXT[];
BEGIN
  IF has_function_privilege('anon', 'public.ensure_mcp_integration_environment_identity_v1()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.ensure_mcp_integration_environment_identity_v1()', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.ensure_mcp_integration_environment_identity_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Integration provisioning ACL differs';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","ref":"tilwaprottpyhlfoggbb"}', true);
  BEGIN
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Authenticated JWT unexpectedly provisioned identity';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role","ref":"yvglwblxrnrenfifsnje"}', true);
  BEGIN
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Production ref unexpectedly provisioned Integration';
  EXCEPTION WHEN SQLSTATE 'DI007' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role","ref":"abcdefghijklmnopqrst"}', true);
  BEGIN
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Other Preview ref unexpectedly provisioned Integration';
  EXCEPTION WHEN SQLSTATE 'DI007' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role","ref":"tilwaprottpyhlfoggbb"}', true);
  -- Each unexpected success is rolled back before the next negative case.
  -- Report all missing guards together rather than allowing an earlier identity
  -- to make later tests pass via the unrelated singleton error.
  BEGIN
    UPDATE auth.users SET last_sign_in_at = pg_catalog.now();
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Used user fields unexpectedly accepted' USING ERRCODE = 'PT001';
  EXCEPTION
    WHEN SQLSTATE 'DI005' THEN NULL;
    WHEN SQLSTATE 'PT001' THEN v_failures := array_append(v_failures, 'used user fields');
  END;

  BEGIN
    INSERT INTO auth.sessions(id, user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
      pg_catalog.now(), pg_catalog.now());
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Auth session unexpectedly accepted' USING ERRCODE = 'PT001';
  EXCEPTION
    WHEN SQLSTATE 'DI005' THEN NULL;
    WHEN SQLSTATE 'PT001' THEN v_failures := array_append(v_failures, 'Auth session');
  END;

  BEGIN
    INSERT INTO auth.oauth_client_states(id, provider_type, code_verifier, created_at)
    VALUES (gen_random_uuid(), 'google', 'isolated-integration-test', pg_catalog.now());
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Auth OAuth state unexpectedly accepted' USING ERRCODE = 'PT001';
  EXCEPTION
    WHEN SQLSTATE 'DI005' THEN NULL;
    WHEN SQLSTATE 'PT001' THEN v_failures := array_append(v_failures, 'Auth OAuth state');
  END;

  BEGIN
    PERFORM public.provision_mcp_preview_environment_identity_v1(
      'https://product-git-integration-dayopt.vercel.app',
      'https://product-git-integration-dayopt.vercel.app', 'tilwaprottpyhlfoggbb');
    RAISE EXCEPTION 'Preview RPC accepted fixed Integration' USING ERRCODE = 'PT001';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
    WHEN SQLSTATE 'PT001' THEN v_failures := array_append(v_failures, 'fixed Integration via Preview RPC');
  END;

  BEGIN
    INSERT INTO public.mcp_environment_identity (
      environment, authorization_server_uri, resource_uri, supabase_project_ref
    ) VALUES ('preview', 'https://product-git-integration-dayopt.vercel.app',
      'https://product-git-integration-dayopt.vercel.app', 'tilwaprottpyhlfoggbb');
    RAISE EXCEPTION 'Preview constraint accepted fixed Integration' USING ERRCODE = 'PT001';
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN SQLSTATE 'PT001' THEN v_failures := array_append(v_failures, 'fixed Integration via constraint');
  END;

  IF pg_catalog.cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION 'Missing Integration identity guards: %', v_failures;
  END IF;

  BEGIN
    INSERT INTO public.mcp_environment_identity (
      environment, authorization_server_uri, resource_uri, supabase_project_ref
    ) VALUES (
      'integration', 'https://product-integration-dayopt.vercel.app',
      'https://product-integration-dayopt.vercel.app', 'tilwaprottpyhlfoggbb'
    );
    RAISE EXCEPTION 'Old Integration origin unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.mcp_environment_identity (
      environment, authorization_server_uri, resource_uri
    ) VALUES ('production', 'https://app.dayopt.app', 'https://mcp.dayopt.app');
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Existing Production identity unexpectedly replaced';
  EXCEPTION WHEN SQLSTATE 'DI002' THEN NULL;
  END;

  UPDATE public.mcp_mutation_control SET writes_enabled = true;
  BEGIN
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Open write gate unexpectedly allowed provisioning';
  EXCEPTION WHEN SQLSTATE 'DI004' THEN NULL;
  END;
  UPDATE public.mcp_mutation_control SET writes_enabled = false;

  BEGIN
    INSERT INTO auth.users(id, email, raw_user_meta_data)
    VALUES (v_extra_user, v_extra_user::TEXT || '@example.invalid', '{}');
    PERFORM public.ensure_mcp_integration_environment_identity_v1();
    RAISE EXCEPTION 'Additional Auth user unexpectedly allowed provisioning';
  EXCEPTION WHEN SQLSTATE 'DI005' THEN
    -- The subtransaction also rolls back the additional synthetic user.
    NULL;
  END;

  SELECT * INTO STRICT v_identity
  FROM public.ensure_mcp_integration_environment_identity_v1();
  IF v_identity.environment <> 'integration'
    OR v_identity.authorization_server_uri <> 'https://product-git-integration-dayopt.vercel.app'
    OR v_identity.resource_uri <> 'https://product-git-integration-dayopt.vercel.app'
    OR v_identity.supabase_project_ref <> 'tilwaprottpyhlfoggbb' THEN
    RAISE EXCEPTION 'Canonical Integration tuple differs';
  END IF;

  SELECT * INTO STRICT v_repeated
  FROM public.ensure_mcp_integration_environment_identity_v1();
  IF v_repeated.provisioned_at <> v_identity.provisioned_at
    OR (SELECT count(*) FROM public.mcp_environment_identity) <> 1 THEN
    RAISE EXCEPTION 'Provisioning is not idempotent';
  END IF;

END
$test$;
ROLLBACK;
