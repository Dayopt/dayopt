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

DO $test$
DECLARE
  v_identity RECORD;
  v_repeated RECORD;
  v_extra_user UUID := gen_random_uuid();
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
