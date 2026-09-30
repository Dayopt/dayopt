-- Add one immutable OAuth identity for the fixed, persistent Integration
-- environment. Production keeps its existing tuple, and Preview keeps its
-- branch-specific provisioning flow.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.mcp_environment_identity
  DROP CONSTRAINT mcp_environment_identity_environment_check,
  ADD CONSTRAINT mcp_environment_identity_environment_check
    CHECK (environment IN ('production', 'preview', 'integration'));

ALTER TABLE public.mcp_environment_identity
  DROP CONSTRAINT mcp_environment_identity_tuple_check,
  ADD CONSTRAINT mcp_environment_identity_tuple_check CHECK (
    (
      environment = 'production'
      AND authorization_server_uri = 'https://app.dayopt.app'
      AND resource_uri = 'https://mcp.dayopt.app'
      AND supabase_project_ref IS NULL
    )
    OR
    (
      environment = 'preview'
      AND authorization_server_uri = resource_uri
      AND authorization_server_uri
        ~ '^https://product-git-[a-z0-9-]+-dayopt[.]vercel[.]app$'
      AND supabase_project_ref IS NOT NULL
      AND supabase_project_ref ~ '^[a-z]{20}$'
    )
    OR
    (
      environment = 'integration'
      AND authorization_server_uri = 'https://product-integration.vercel.app'
      AND resource_uri = 'https://product-integration.vercel.app'
      AND supabase_project_ref = 'tilwaprottpyhlfoggbb'
    )
  );

CREATE FUNCTION public.ensure_mcp_integration_environment_identity_v1()
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
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  IF auth.jwt() ->> 'ref' IS DISTINCT FROM 'tilwaprottpyhlfoggbb' THEN
    RAISE EXCEPTION 'MCP Integration Supabase project binding is unavailable'
      USING ERRCODE = 'DI007';
  END IF;

  LOCK TABLE public.mcp_environment_identity IN EXCLUSIVE MODE;

  SELECT identity.*
  INTO v_identity
  FROM public.mcp_environment_identity AS identity
  WHERE identity.singleton_key = true;

  IF FOUND THEN
    IF v_identity.environment = 'integration'
      AND v_identity.authorization_server_uri = 'https://product-integration.vercel.app'
      AND v_identity.resource_uri = 'https://product-integration.vercel.app'
      AND v_identity.supabase_project_ref = 'tilwaprottpyhlfoggbb' THEN
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
    RAISE EXCEPTION 'MCP Integration identity requires closed write gates'
      USING ERRCODE = 'DI004';
  END IF;

  -- Integration is seeded only with the fixed, synthetic fixture. Hold the
  -- Auth tables against concurrent account creation while checking it.
  LOCK TABLE auth.users IN SHARE MODE;
  LOCK TABLE auth.identities IN SHARE MODE;
  LOCK TABLE public.oauth_connections IN SHARE MODE;
  LOCK TABLE public.oauth_authorization_codes IN SHARE MODE;
  LOCK TABLE public.oauth_tokens IN SHARE MODE;
  LOCK TABLE public.oauth_audit_log IN SHARE MODE;
  LOCK TABLE public.mcp_mutation_receipts IN SHARE MODE;

  IF (SELECT pg_catalog.count(*) FROM auth.users) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM auth.users AS app_user
      WHERE app_user.id = '00000000-0000-0000-0000-000000000001'::UUID
        AND app_user.instance_id = '00000000-0000-0000-0000-000000000000'::UUID
        AND app_user.email = 'test@dayopt.dev'
        AND app_user.encrypted_password IS NOT NULL
        AND app_user.encrypted_password = extensions.crypt(
          'TestPassword123!',
          app_user.encrypted_password
        )
        AND app_user.email_confirmed_at IS NOT NULL
        AND app_user.raw_app_meta_data =
          '{"provider":"email","providers":["email"]}'::JSONB
        AND app_user.raw_user_meta_data = '{"full_name":"Test User"}'::JSONB
        AND app_user.role = 'authenticated'
        AND app_user.aud = 'authenticated'
        AND COALESCE(app_user.is_sso_user, false) = false
        AND COALESCE(app_user.is_anonymous, false) = false
    )
    OR (SELECT pg_catalog.count(*) FROM auth.identities) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM auth.identities AS identity
      WHERE identity.id = '00000000-0000-0000-0000-000000000001'::UUID
        AND identity.user_id = '00000000-0000-0000-0000-000000000001'::UUID
        AND identity.provider_id = 'test@dayopt.dev'
        AND identity.provider = 'email'
        AND identity.email = 'test@dayopt.dev'
        AND identity.identity_data = jsonb_build_object(
          'sub', '00000000-0000-0000-0000-000000000001',
          'email', 'test@dayopt.dev'
        )
    ) THEN
    RAISE EXCEPTION 'MCP Integration identity requires the exact synthetic Auth fixture'
      USING ERRCODE = 'DI005';
  END IF;

  IF EXISTS (SELECT 1 FROM public.oauth_connections)
    OR EXISTS (SELECT 1 FROM public.oauth_authorization_codes)
    OR EXISTS (SELECT 1 FROM public.oauth_tokens)
    OR EXISTS (SELECT 1 FROM public.oauth_audit_log)
    OR EXISTS (SELECT 1 FROM public.mcp_mutation_receipts) THEN
    RAISE EXCEPTION 'MCP Integration identity cannot follow existing authority'
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
    'integration',
    'https://product-integration.vercel.app',
    'https://product-integration.vercel.app',
    'tilwaprottpyhlfoggbb'
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

REVOKE ALL ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  TO service_role;

COMMENT ON FUNCTION public.ensure_mcp_integration_environment_identity_v1() IS
  'Creates the fixed Integration OAuth identity once, only on its exact Supabase project and only with the synthetic Auth fixture and closed MCP write gates.';

COMMIT;
