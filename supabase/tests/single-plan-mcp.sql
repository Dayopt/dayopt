-- Isolated database; fixtures and control changes are rolled back.
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
INSERT INTO public.mcp_environment_identity(singleton_key,environment,authorization_server_uri,resource_uri)
VALUES(true,'production','https://app.dayopt.app','https://mcp.dayopt.app') ON CONFLICT DO NOTHING;
INSERT INTO public.mcp_mutation_control(singleton_key,writes_enabled,enabled_client_ids)
VALUES(true,true,ARRAY['chatgpt']) ON CONFLICT(singleton_key)
DO UPDATE SET writes_enabled=true,enabled_client_ids=ARRAY['chatgpt'];
DO $test$
DECLARE
  u uuid := gen_random_uuid();
  connection uuid;
  token uuid;
  created_id uuid;
  exchange record;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.invalid','{}');
  UPDATE public.profiles SET app_trial_started_at=now()-interval '1 hour',
    app_trial_ends_at=now()+interval '1079 hours' WHERE id=u;
  SELECT public.create_oauth_authorization_grant_v2(u,'chatgpt','https://mcp.dayopt.app',
    ARRAY['read:entries','write:plans'],repeat('a',64),
    'https://chatgpt.com/connector_platform_oauth_redirect',repeat('x',43),true) INTO connection;
  SELECT * INTO exchange FROM public.exchange_oauth_authorization_code_v2(
    repeat('a',64),'chatgpt','https://chatgpt.com/connector_platform_oauth_redirect',
    'https://mcp.dayopt.app',repeat('x',43),repeat('b',64),repeat('c',64));
  token:=exchange.access_id;
  PERFORM private.authorize_mcp_mutation_v1(connection,token,'write:plans',gen_random_uuid());
  -- Execute the actual MCP writer, rather than checking a boolean alone.
  PERFORM public.apply_mcp_plan_create_v1(connection,token,gen_random_uuid(),'trial fixture',NULL,
    now()+interval '1 hour',now()+interval '2 hours');
  IF NOT EXISTS(SELECT 1 FROM public.plans WHERE user_id=u AND title='trial fixture') THEN
    RAISE EXCEPTION 'trial MCP create did not persist';
  END IF;
  UPDATE public.profiles SET app_trial_started_at=now()-interval '1080 hours',app_trial_ends_at=now() WHERE id=u;
  BEGIN
    PERFORM public.apply_mcp_plan_create_v1(connection,token,gen_random_uuid(),'expired fixture',NULL,
      now()+interval '3 hours',now()+interval '4 hours');
    RAISE EXCEPTION 'expired MCP write accepted';
  EXCEPTION WHEN SQLSTATE 'DM005' THEN NULL;
  END;
  UPDATE public.profiles SET subscription_status='active' WHERE id=u;
  PERFORM private.authorize_mcp_mutation_v1(connection,token,'write:plans',gen_random_uuid());
  UPDATE public.oauth_tokens SET revoked_at=now() WHERE id=token;
  BEGIN
    PERFORM private.authorize_mcp_mutation_v1(connection,token,'write:plans',gen_random_uuid());
    RAISE EXCEPTION 'revoked token accepted for subscriber';
  EXCEPTION WHEN SQLSTATE 'DM004' THEN NULL;
  END;
END;
$test$;
ROLLBACK;
