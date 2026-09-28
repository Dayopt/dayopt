-- Move the unprovisioned Integration identity to the existing Product project.
-- Applied historical migrations remain unchanged; Production/Preview tuples
-- and all provisioning authority checks retain their existing contracts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Serialize the preflight with the provisioning function's identical lock.
LOCK TABLE public.mcp_environment_identity IN EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_definition TEXT;
  v_constraint TEXT;
  v_old_origin CONSTANT TEXT := 'https://product-integration-dayopt.vercel.app';
  v_new_origin CONSTANT TEXT := 'https://product-git-integration-dayopt.vercel.app';
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.mcp_environment_identity WHERE environment = 'integration'
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

  IF (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_origin, '')))
      / pg_catalog.length(v_old_origin) <> 4 THEN
    RAISE EXCEPTION 'Integration provisioning function does not match the expected predecessor origin'
      USING ERRCODE = 'DI009';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid)
  INTO STRICT v_constraint
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.mcp_environment_identity'::regclass
    AND c.conname = 'mcp_environment_identity_tuple_check'
    AND c.contype = 'c';

  IF (pg_catalog.length(v_constraint)
      - pg_catalog.length(pg_catalog.replace(v_constraint, v_old_origin, '')))
      / pg_catalog.length(v_old_origin) <> 2 THEN
    RAISE EXCEPTION 'Integration tuple constraint does not match the expected predecessor origin'
      USING ERRCODE = 'DI009';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_old_origin, v_new_origin);
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
      AND authorization_server_uri = 'https://product-git-integration-dayopt.vercel.app'
      AND resource_uri = 'https://product-git-integration-dayopt.vercel.app'
      AND supabase_project_ref = 'tilwaprottpyhlfoggbb'
    )
  );

REVOKE ALL ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_mcp_integration_environment_identity_v1()
  TO service_role;

COMMIT;
