-- Correct the persistent Integration OAuth origin after Vercel exposed
-- product-integration-dayopt.vercel.app as the stable project alias.
-- Keep the already-applied historical migration immutable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_definition TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.mcp_environment_identity
    WHERE environment = 'integration'
  ) THEN
    RAISE EXCEPTION 'Refusing Integration origin cutover after identity provisioning'
      USING ERRCODE = 'DI008';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(p.oid)
  INTO STRICT v_definition
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'ensure_mcp_integration_environment_identity_v1'
    AND p.pronargs = 0;

  IF pg_catalog.strpos(
    v_definition,
    'https://product-integration.vercel.app'
  ) = 0 THEN
    RAISE EXCEPTION 'Existing Integration provisioning function does not contain the expected old origin'
      USING ERRCODE = 'DI009';
  END IF;

  v_definition := pg_catalog.replace(
    v_definition,
    'https://product-integration.vercel.app',
    'https://product-integration-dayopt.vercel.app'
  );

  EXECUTE v_definition;
END
$migration$;

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
      AND authorization_server_uri = 'https://product-integration-dayopt.vercel.app'
      AND resource_uri = 'https://product-integration-dayopt.vercel.app'
      AND supabase_project_ref = 'tilwaprottpyhlfoggbb'
    )
  );

REVOKE ALL ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  TO service_role;

COMMIT;
