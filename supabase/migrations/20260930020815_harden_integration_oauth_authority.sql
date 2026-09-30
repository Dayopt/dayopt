-- Preserve the three already-applied Integration migrations. Harden only the
-- initial identity provisioning; existing correct identities remain readable.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.mcp_environment_identity IN EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_definition TEXT;
  v_matches BOOLEAN;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid),
    p.prosecdef
    AND p.proconfig = ARRAY['search_path=""', 'lock_timeout=5s']::TEXT[]
    AND pg_catalog.encode(extensions.digest(p.prosrc, 'sha256'), 'hex')
      = 'f1a6bea9b2d48f440e61bc69b2a64247b6634f78b96a0f6650a019fad75d2f41'
  INTO STRICT v_definition, v_matches
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.ensure_mcp_integration_environment_identity_v1()'::regprocedure;
  IF v_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Integration provisioning predecessor differs' USING ERRCODE = 'DI009';
  END IF;

  v_definition := pg_catalog.replace(v_definition,
    '  LOCK TABLE auth.identities IN SHARE MODE;',
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
  LOCK TABLE auth.webauthn_credentials IN SHARE MODE;$locks$);

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
  EXECUTE v_definition;

  SELECT pg_catalog.pg_get_functiondef(p.oid),
    p.prosecdef
    AND p.proconfig = ARRAY['search_path=""', 'lock_timeout=5s']::TEXT[]
    AND pg_catalog.encode(extensions.digest(p.prosrc, 'sha256'), 'hex')
      = '37a810795dc67c6d9299c1bd65010b85cf5158897d720a3627d164c6f49c55d3'
  INTO STRICT v_definition, v_matches
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.provision_mcp_preview_environment_identity_v1(text,text,text)'::regprocedure;
  IF v_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Preview provisioning predecessor differs' USING ERRCODE = 'DI009';
  END IF;

  v_definition := pg_catalog.replace(v_definition,
    '  IF p_authorization_server_uri IS DISTINCT FROM p_resource_uri',
    $preview$  IF p_authorization_server_uri = 'https://product-git-integration-dayopt.vercel.app'
    OR p_resource_uri = 'https://product-git-integration-dayopt.vercel.app'
    OR p_supabase_project_ref = 'tilwaprottpyhlfoggbb'
    OR p_authorization_server_uri IS DISTINCT FROM p_resource_uri$preview$);
  EXECUTE v_definition;
END
$migration$;

-- Reject either component of the fixed Integration binding, even if a caller
-- bypasses the RPC. Validation fails on an existing bad tuple rather than
-- rewriting or deleting an immutable identity.
ALTER TABLE public.mcp_environment_identity
  ADD CONSTRAINT mcp_environment_identity_preview_integration_fence_check CHECK (
    environment <> 'preview'
    OR (
      authorization_server_uri <> 'https://product-git-integration-dayopt.vercel.app'
      AND resource_uri <> 'https://product-git-integration-dayopt.vercel.app'
      AND supabase_project_ref <> 'tilwaprottpyhlfoggbb'
    )
  );

COMMIT;
