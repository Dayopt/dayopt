-- Allow the stable Preview sample's legacy and current email tuples while
-- keeping every Auth identity field bound to the same email. The fixed
-- Integration branch remains excluded from Preview provisioning.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.provision_mcp_preview_environment_identity_v1(
  p_authorization_server_uri TEXT,
  p_resource_uri TEXT,
  p_supabase_project_ref TEXT
)
RETURNS TABLE(
  environment TEXT,
  authorization_server_uri TEXT,
  resource_uri TEXT,
  supabase_project_ref TEXT,
  provisioned_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_identity public.mcp_environment_identity%ROWTYPE;
  v_control public.mcp_mutation_control%ROWTYPE;
  v_jwt_project_ref TEXT;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  v_jwt_project_ref := auth.jwt() ->> 'ref';
  IF v_jwt_project_ref IS NULL
    OR v_jwt_project_ref IS DISTINCT FROM p_supabase_project_ref THEN
    RAISE EXCEPTION 'MCP Preview Supabase project binding is unavailable'
      USING ERRCODE = 'DI007';
  END IF;

  IF p_authorization_server_uri = 'https://product-git-integration-dayopt.vercel.app'
    OR p_resource_uri = 'https://product-git-integration-dayopt.vercel.app'
    OR p_supabase_project_ref = 'tilwaprottpyhlfoggbb'
    OR p_authorization_server_uri IS DISTINCT FROM p_resource_uri
    OR p_authorization_server_uri
      !~ '^https://product-git-[a-z0-9-]+-dayopt[.]vercel[.]app$'
    OR p_supabase_project_ref !~ '^[a-z]{20}$' THEN
    RAISE EXCEPTION 'Invalid MCP Preview environment identity'
      USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.mcp_environment_identity IN EXCLUSIVE MODE;

  SELECT identity.*
  INTO v_identity
  FROM public.mcp_environment_identity AS identity
  WHERE identity.singleton_key = true;

  IF FOUND THEN
    IF v_identity.environment = 'preview'
      AND v_identity.authorization_server_uri = p_authorization_server_uri
      AND v_identity.resource_uri = p_resource_uri
      AND v_identity.supabase_project_ref = p_supabase_project_ref THEN
      RETURN QUERY SELECT
        v_identity.environment,
        v_identity.authorization_server_uri,
        v_identity.resource_uri,
        v_identity.supabase_project_ref,
        v_identity.provisioned_at;
      RETURN;
    END IF;

    RAISE EXCEPTION 'MCP environment identity is already provisioned'
      USING ERRCODE = 'DI002';
  END IF;

  SELECT control.*
  INTO v_control
  FROM public.mcp_mutation_control AS control
  WHERE control.singleton_key = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP mutation control is missing'
      USING ERRCODE = 'DI003';
  END IF;

  IF v_control.writes_enabled
    OR COALESCE(pg_catalog.cardinality(v_control.enabled_client_ids), 0) <> 0 THEN
    RAISE EXCEPTION 'MCP environment identity requires closed write gates'
      USING ERRCODE = 'DI004';
  END IF;

  -- Keep the Auth proof, OAuth proof, and identity insert in one transaction.
  -- Only seed.sql's exact email/password identity may exist, and it must never
  -- have been used to create session, recovery, MFA, OAuth, or WebAuthn state.
  LOCK TABLE auth.users IN SHARE MODE;
  LOCK TABLE auth.identities IN SHARE MODE;
  LOCK TABLE auth.flow_state IN SHARE MODE;
  LOCK TABLE auth.mfa_amr_claims IN SHARE MODE;
  LOCK TABLE auth.mfa_factors IN SHARE MODE;
  LOCK TABLE auth.oauth_authorizations IN SHARE MODE;
  LOCK TABLE auth.oauth_consents IN SHARE MODE;
  LOCK TABLE auth.one_time_tokens IN SHARE MODE;
  LOCK TABLE auth.refresh_tokens IN SHARE MODE;
  LOCK TABLE auth.sessions IN SHARE MODE;
  LOCK TABLE auth.webauthn_challenges IN SHARE MODE;
  LOCK TABLE auth.webauthn_credentials IN SHARE MODE;
  LOCK TABLE public.oauth_connections IN SHARE MODE;
  LOCK TABLE public.oauth_authorization_codes IN SHARE MODE;
  LOCK TABLE public.oauth_tokens IN SHARE MODE;
  LOCK TABLE public.oauth_audit_log IN SHARE MODE;
  LOCK TABLE public.mcp_mutation_receipts IN SHARE MODE;

  IF EXISTS (SELECT 1 FROM auth.users) THEN
    IF (SELECT pg_catalog.count(*) FROM auth.users) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM auth.users AS app_user
        WHERE app_user.id =
            '00000000-0000-0000-0000-000000000001'::UUID
          AND app_user.instance_id =
            '00000000-0000-0000-0000-000000000000'::UUID
          AND app_user.email IN ('test@dayopt.dev', 'test-seed@dayopt.dev')
          AND app_user.encrypted_password IS NOT NULL
          AND app_user.encrypted_password = extensions.crypt(
            'TestPassword123!',
            app_user.encrypted_password
          )
          AND app_user.email_confirmed_at IS NOT NULL
          AND app_user.raw_app_meta_data =
            '{"provider":"email","providers":["email"]}'::JSONB
          AND app_user.raw_user_meta_data =
            '{"full_name":"Test User"}'::JSONB
          AND app_user.role = 'authenticated'
          AND app_user.aud = 'authenticated'
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
          AND app_user.deleted_at IS NULL
          AND NOT COALESCE(app_user.is_sso_user, false)
          AND NOT COALESCE(app_user.is_anonymous, false)
      )
      OR (SELECT pg_catalog.count(*) FROM auth.identities) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM auth.identities AS identity
        JOIN auth.users AS app_user ON app_user.id = identity.user_id
        WHERE identity.id =
            '00000000-0000-0000-0000-000000000001'::UUID
          AND identity.user_id =
            '00000000-0000-0000-0000-000000000001'::UUID
          AND app_user.email IN ('test@dayopt.dev', 'test-seed@dayopt.dev')
          AND identity.provider_id = app_user.email
          AND identity.provider = 'email'
          AND identity.email = app_user.email
          AND identity.identity_data =
            jsonb_build_object(
              'sub',
              '00000000-0000-0000-0000-000000000001',
              'email',
              app_user.email
            )
          AND identity.last_sign_in_at IS NOT NULL
      ) THEN
      RAISE EXCEPTION
        'Preview MCP identity requires the exact unused auth seed fixture'
        USING ERRCODE = 'DI005';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM auth.identities) THEN
    RAISE EXCEPTION
      'Preview MCP identity requires an empty database or the exact auth seed fixture'
      USING ERRCODE = 'DI005';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.flow_state)
    OR EXISTS (SELECT 1 FROM auth.mfa_amr_claims)
    OR EXISTS (SELECT 1 FROM auth.mfa_factors)
    OR EXISTS (SELECT 1 FROM auth.oauth_authorizations)
    OR EXISTS (SELECT 1 FROM auth.oauth_consents)
    OR EXISTS (SELECT 1 FROM auth.one_time_tokens)
    OR EXISTS (SELECT 1 FROM auth.refresh_tokens)
    OR EXISTS (SELECT 1 FROM auth.sessions)
    OR EXISTS (SELECT 1 FROM auth.webauthn_challenges)
    OR EXISTS (SELECT 1 FROM auth.webauthn_credentials) THEN
    RAISE EXCEPTION
      'Preview MCP identity requires unused Auth authority'
      USING ERRCODE = 'DI005';
  END IF;

  IF EXISTS (SELECT 1 FROM public.oauth_connections)
    OR EXISTS (SELECT 1 FROM public.oauth_authorization_codes)
    OR EXISTS (SELECT 1 FROM public.oauth_tokens)
    OR EXISTS (SELECT 1 FROM public.oauth_audit_log)
    OR EXISTS (SELECT 1 FROM public.mcp_mutation_receipts) THEN
    RAISE EXCEPTION 'MCP environment identity cannot follow existing authority'
      USING ERRCODE = 'DI006';
  END IF;

  INSERT INTO public.mcp_environment_identity (
    singleton_key,
    environment,
    authorization_server_uri,
    resource_uri,
    supabase_project_ref
  ) VALUES (
    true,
    'preview',
    p_authorization_server_uri,
    p_resource_uri,
    p_supabase_project_ref
  )
  RETURNING * INTO v_identity;

  RETURN QUERY SELECT
    v_identity.environment,
    v_identity.authorization_server_uri,
    v_identity.resource_uri,
    v_identity.supabase_project_ref,
    v_identity.provisioned_at;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_mcp_preview_environment_identity_v1(
  TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provision_mcp_preview_environment_identity_v1(
  TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.provision_mcp_preview_environment_identity_v1(
  TEXT, TEXT, TEXT
) IS
  'Binds an empty or exact unused-auth-seed Preview DB to its Vercel URL and Supabase ref while write gates are closed.';

COMMIT;
