-- Isolated database. Fixtures and control changes are rolled back.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

DO $test$
DECLARE
  app_user_id UUID := gen_random_uuid();
  connection_id UUID;
  access_token_id UUID;
  exchange_result RECORD;
  control_result RECORD;
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.set_mcp_billing_enforcement_v1(boolean,bigint)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can change MCP billing enforcement';
  END IF;

  INSERT INTO public.mcp_environment_identity(
    singleton_key,
    environment,
    authorization_server_uri,
    resource_uri
  ) VALUES (
    true,
    'production',
    'https://app.dayopt.app',
    'https://mcp.dayopt.app'
  ) ON CONFLICT (singleton_key) DO NOTHING;

  INSERT INTO public.mcp_mutation_control(
    singleton_key,
    writes_enabled,
    billing_enforced,
    enabled_client_ids,
    revision
  ) VALUES (
    true,
    true,
    false,
    ARRAY['chatgpt'],
    0
  ) ON CONFLICT (singleton_key) DO UPDATE
  SET writes_enabled = true,
      billing_enforced = false,
      enabled_client_ids = ARRAY['chatgpt'],
      revision = 0;

  INSERT INTO auth.users(id, email, raw_user_meta_data)
  VALUES(app_user_id, app_user_id::TEXT || '@example.invalid', '{}');

  UPDATE public.profiles
  SET subscription_status = 'active'
  WHERE id = app_user_id;

  SELECT public.create_oauth_authorization_grant_v2(
    app_user_id,
    'chatgpt',
    'https://mcp.dayopt.app',
    ARRAY['read:entries', 'write:plans'],
    repeat('a', 64),
    'https://chatgpt.com/connector_platform_oauth_redirect',
    repeat('x', 43),
    true
  ) INTO connection_id;

  SELECT * INTO exchange_result
  FROM public.exchange_oauth_authorization_code_v2(
    repeat('a', 64),
    'chatgpt',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://mcp.dayopt.app',
    repeat('x', 43),
    repeat('b', 64),
    repeat('c', 64)
  );
  access_token_id := exchange_result.access_id;

  -- billing_enforced=false preserves the existing subscriber-only contract.
  PERFORM private.authorize_mcp_mutation_v1(
    connection_id,
    access_token_id,
    'write:plans',
    gen_random_uuid()
  );

  UPDATE public.profiles
  SET subscription_status = 'free',
      app_trial_started_at = pg_catalog.now() - INTERVAL '1 hour',
      app_trial_ends_at = pg_catalog.now() + INTERVAL '1079 hours',
      app_trial_consumed_at = NULL
  WHERE id = app_user_id;

  BEGIN
    PERFORM private.authorize_mcp_mutation_v1(
      connection_id,
      access_token_id,
      'write:plans',
      gen_random_uuid()
    );
    RAISE EXCEPTION 'app trial accepted before MCP billing activation';
  EXCEPTION WHEN SQLSTATE 'DM005' THEN
    NULL;
  END;

  SELECT * INTO control_result
  FROM public.set_mcp_billing_enforcement_v1(true, 0);

  IF NOT control_result.billing_enforced OR control_result.revision <> 1 THEN
    RAISE EXCEPTION 'MCP billing activation did not advance the control revision';
  END IF;

  BEGIN
    PERFORM public.set_mcp_billing_enforcement_v1(false, 0);
    RAISE EXCEPTION 'stale MCP billing revision was accepted';
  EXCEPTION WHEN SQLSTATE 'DM001' THEN
    NULL;
  END;

  PERFORM public.apply_mcp_plan_create_v1(
    connection_id,
    access_token_id,
    gen_random_uuid(),
    'trial fixture',
    NULL,
    pg_catalog.now() + INTERVAL '1 hour',
    pg_catalog.now() + INTERVAL '2 hours'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.plans
    WHERE user_id = app_user_id
      AND title = 'trial fixture'
  ) THEN
    RAISE EXCEPTION 'active app trial MCP write did not persist';
  END IF;

  UPDATE public.profiles
  SET app_trial_started_at = pg_catalog.now() - INTERVAL '1080 hours',
      app_trial_ends_at = pg_catalog.now()
  WHERE id = app_user_id;

  BEGIN
    PERFORM public.apply_mcp_plan_create_v1(
      connection_id,
      access_token_id,
      gen_random_uuid(),
      'expired fixture',
      NULL,
      pg_catalog.now() + INTERVAL '3 hours',
      pg_catalog.now() + INTERVAL '4 hours'
    );
    RAISE EXCEPTION 'expired app trial MCP write accepted';
  EXCEPTION WHEN SQLSTATE 'DM005' THEN
    NULL;
  END;

  UPDATE public.profiles
  SET app_trial_started_at = pg_catalog.now() - INTERVAL '1 hour',
      app_trial_ends_at = pg_catalog.now() + INTERVAL '1079 hours',
      app_trial_consumed_at = pg_catalog.now()
  WHERE id = app_user_id;

  BEGIN
    PERFORM public.apply_mcp_plan_create_v1(
      connection_id,
      access_token_id,
      gen_random_uuid(),
      'consumed fixture',
      NULL,
      pg_catalog.now() + INTERVAL '5 hours',
      pg_catalog.now() + INTERVAL '6 hours'
    );
    RAISE EXCEPTION 'consumed app trial MCP write accepted';
  EXCEPTION WHEN SQLSTATE 'DM005' THEN
    NULL;
  END;

  UPDATE public.profiles
  SET subscription_status = 'past_due'
  WHERE id = app_user_id;

  PERFORM private.authorize_mcp_mutation_v1(
    connection_id,
    access_token_id,
    'write:plans',
    gen_random_uuid()
  );

  UPDATE public.oauth_tokens
  SET revoked_at = pg_catalog.now()
  WHERE id = access_token_id;

  BEGIN
    PERFORM private.authorize_mcp_mutation_v1(
      connection_id,
      access_token_id,
      'write:plans',
      gen_random_uuid()
    );
    RAISE EXCEPTION 'revoked token accepted after billing activation';
  EXCEPTION WHEN SQLSTATE 'DM004' THEN
    NULL;
  END;

  SELECT * INTO control_result
  FROM public.set_mcp_billing_enforcement_v1(false, 1);

  IF control_result.billing_enforced OR control_result.revision <> 2 THEN
    RAISE EXCEPTION 'MCP billing rollback did not advance the control revision';
  END IF;
END;
$test$;

ROLLBACK;
