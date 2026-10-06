-- Restore the current Auth protections while accepting the coherent current
-- sample email tuple. The preceding migrations remain immutable.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_definition TEXT;
  v_before TEXT;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid)
  INTO STRICT v_definition
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.provision_mcp_preview_environment_identity_v1(text,text,text)'::regprocedure;

  IF v_definition NOT LIKE '%app_user.confirmation_token%'
    OR v_definition NOT LIKE '%app_user.last_sign_in_at IS NULL%'
    OR v_definition NOT LIKE '%auth.oauth_consents%'
    OR v_definition LIKE '%auth.oauth_client_states%' THEN
    RAISE EXCEPTION 'Preview provisioning predecessor differs' USING ERRCODE = 'DI009';
  END IF;

  v_before := v_definition;
  v_definition := pg_catalog.replace(v_definition,
    '  LOCK TABLE auth.oauth_consents IN SHARE MODE;',
    $locks$  LOCK TABLE auth.oauth_consents IN SHARE MODE;
  LOCK TABLE auth.oauth_client_states IN SHARE MODE;$locks$);
  v_definition := pg_catalog.replace(v_definition,
    '    OR EXISTS (SELECT 1 FROM auth.oauth_consents)',
    $state$    OR EXISTS (SELECT 1 FROM auth.oauth_consents)
    OR EXISTS (SELECT 1 FROM auth.oauth_client_states)$state$);

  IF v_definition = v_before
    OR v_definition NOT LIKE '%LOCK TABLE auth.oauth_client_states IN SHARE MODE%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.oauth_client_states)%' THEN
    RAISE EXCEPTION 'Preview Auth OAuth-state protection was not restored' USING ERRCODE = 'DI009';
  END IF;

  EXECUTE v_definition;

  SELECT pg_catalog.pg_get_functiondef(p.oid)
  INTO STRICT v_definition
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.ensure_mcp_integration_environment_identity_v1()'::regprocedure;

  IF v_definition NOT LIKE '%app_user.email IN (''test@dayopt.dev'', ''test-seed@dayopt.dev'')%'
    OR v_definition NOT LIKE '%JOIN auth.users AS app_user ON app_user.id = identity.user_id%'
    OR v_definition NOT LIKE '%identity.provider_id = app_user.email%'
    OR v_definition NOT LIKE '%identity.email = app_user.email%'
    OR v_definition NOT LIKE '%''email'', app_user.email%'
    OR v_definition LIKE '%auth.oauth_client_states%' THEN
    RAISE EXCEPTION 'Integration provisioning predecessor differs' USING ERRCODE = 'DI009';
  END IF;

  v_before := v_definition;
  v_definition := pg_catalog.replace(v_definition,
    '  LOCK TABLE auth.identities IN SHARE MODE;
  LOCK TABLE public.oauth_connections IN SHARE MODE;',
    $locks$  LOCK TABLE auth.identities IN SHARE MODE;
  LOCK TABLE auth.flow_state IN SHARE MODE;
  LOCK TABLE auth.mfa_amr_claims IN SHARE MODE;
  LOCK TABLE auth.mfa_factors IN SHARE MODE;
  LOCK TABLE auth.oauth_authorizations IN SHARE MODE;
  LOCK TABLE auth.oauth_consents IN SHARE MODE;
  LOCK TABLE auth.oauth_client_states IN SHARE MODE;
  LOCK TABLE auth.one_time_tokens IN SHARE MODE;
  LOCK TABLE auth.refresh_tokens IN SHARE MODE;
  LOCK TABLE auth.sessions IN SHARE MODE;
  LOCK TABLE auth.webauthn_challenges IN SHARE MODE;
  LOCK TABLE auth.webauthn_credentials IN SHARE MODE;
  LOCK TABLE public.oauth_connections IN SHARE MODE;$locks$);
  v_definition := pg_catalog.replace(v_definition,
    '        AND COALESCE(app_user.is_anonymous, false) = false',
    $fields$        AND COALESCE(app_user.is_anonymous, false) = false
        AND COALESCE(app_user.confirmation_token, '') = ''
        AND COALESCE(app_user.recovery_token, '') = ''
        AND COALESCE(app_user.email_change_token_new, '') = ''
        AND COALESCE(app_user.email_change, '') = ''
        AND COALESCE(app_user.email_change_token_current, '') = ''
        AND COALESCE(app_user.phone, '') = ''
        AND COALESCE(app_user.phone_change, '') = ''
        AND COALESCE(app_user.phone_change_token, '') = ''
        AND COALESCE(app_user.reauthentication_token, '') = ''
        AND app_user.email_change_confirm_status = 0
        AND app_user.last_sign_in_at IS NULL
        AND app_user.banned_until IS NULL
        AND app_user.deleted_at IS NULL$fields$);
  v_definition := pg_catalog.replace(v_definition,
    '  IF EXISTS (SELECT 1 FROM public.oauth_connections)',
    $state$  IF EXISTS (SELECT 1 FROM auth.flow_state)
    OR EXISTS (SELECT 1 FROM auth.mfa_amr_claims)
    OR EXISTS (SELECT 1 FROM auth.mfa_factors)
    OR EXISTS (SELECT 1 FROM auth.oauth_authorizations)
    OR EXISTS (SELECT 1 FROM auth.oauth_consents)
    OR EXISTS (SELECT 1 FROM auth.oauth_client_states)
    OR EXISTS (SELECT 1 FROM auth.one_time_tokens)
    OR EXISTS (SELECT 1 FROM auth.refresh_tokens)
    OR EXISTS (SELECT 1 FROM auth.sessions)
    OR EXISTS (SELECT 1 FROM auth.webauthn_challenges)
    OR EXISTS (SELECT 1 FROM auth.webauthn_credentials) THEN
    RAISE EXCEPTION 'MCP Integration identity requires unused Auth authority'
      USING ERRCODE = 'DI005';
  END IF;

  IF EXISTS (SELECT 1 FROM public.oauth_connections)$state$);

  IF v_definition = v_before
    OR v_definition NOT LIKE '%LOCK TABLE auth.flow_state IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.mfa_amr_claims IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.mfa_factors IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.oauth_authorizations IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.oauth_consents IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.oauth_client_states IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.one_time_tokens IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.refresh_tokens IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.sessions IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.webauthn_challenges IN SHARE MODE%'
    OR v_definition NOT LIKE '%LOCK TABLE auth.webauthn_credentials IN SHARE MODE%'
    OR v_definition NOT LIKE '%app_user.confirmation_token%'
    OR v_definition NOT LIKE '%app_user.recovery_token%'
    OR v_definition NOT LIKE '%app_user.email_change_token_new%'
    OR v_definition NOT LIKE '%app_user.email_change,%'
    OR v_definition NOT LIKE '%app_user.email_change_token_current%'
    OR v_definition NOT LIKE '%app_user.phone,%'
    OR v_definition NOT LIKE '%app_user.phone_change,%'
    OR v_definition NOT LIKE '%app_user.phone_change_token%'
    OR v_definition NOT LIKE '%app_user.reauthentication_token%'
    OR v_definition NOT LIKE '%app_user.email_change_confirm_status = 0%'
    OR v_definition NOT LIKE '%app_user.is_sso_user%'
    OR v_definition NOT LIKE '%app_user.is_anonymous%'
    OR v_definition NOT LIKE '%app_user.last_sign_in_at IS NULL%'
    OR v_definition NOT LIKE '%app_user.banned_until IS NULL%'
    OR v_definition NOT LIKE '%app_user.deleted_at IS NULL%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.flow_state)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.mfa_amr_claims)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.mfa_factors)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.oauth_authorizations)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.oauth_consents)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.oauth_client_states)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.one_time_tokens)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.refresh_tokens)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.sessions)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.webauthn_challenges)%'
    OR v_definition NOT LIKE '%EXISTS (SELECT 1 FROM auth.webauthn_credentials)%'
    OR v_definition NOT LIKE '%app_user.email IN (''test@dayopt.dev'', ''test-seed@dayopt.dev'')%'
    OR v_definition NOT LIKE '%JOIN auth.users AS app_user ON app_user.id = identity.user_id%'
    OR v_definition NOT LIKE '%identity.provider_id = app_user.email%'
    OR v_definition NOT LIKE '%identity.email = app_user.email%'
    OR v_definition NOT LIKE '%''email'', app_user.email%' THEN
    RAISE EXCEPTION 'Integration Auth protections or coherent email tuple were not restored' USING ERRCODE = 'DI009';
  END IF;

  EXECUTE v_definition;
END
$migration$;

REVOKE ALL ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  TO service_role;

COMMENT ON FUNCTION public.ensure_mcp_integration_environment_identity_v1() IS
  'Creates the fixed Integration OAuth identity once, only on its exact Supabase project and only with a fully protected coherent historical or current synthetic Auth fixture and closed MCP write gates.';

COMMIT;
