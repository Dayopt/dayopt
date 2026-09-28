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
  v_function_matches BOOLEAN;
  v_constraint_validated BOOLEAN;
  v_old_origin CONSTANT TEXT := 'https://product-integration-dayopt.vercel.app';
  v_new_origin CONSTANT TEXT := 'https://product-git-integration-dayopt.vercel.app';
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.mcp_environment_identity WHERE environment = 'integration'
  ) THEN
    RAISE EXCEPTION 'Refusing Integration origin cutover after identity provisioning'
      USING ERRCODE = 'DI008';
  END IF;

  -- The body fingerprint is derived from the immutable first migration after
  -- applying the second migration's exact origin replacement. Also retain its
  -- SECURITY DEFINER and search_path/lock_timeout metadata.
  SELECT pg_catalog.pg_get_functiondef(p.oid),
    p.prosecdef
    AND p.proconfig = ARRAY['search_path=""', 'lock_timeout=5s']::TEXT[]
    AND pg_catalog.encode(extensions.digest(p.prosrc, 'sha256'), 'hex')
      = 'e1455878619b101f2fd9cd1b73689527fd954859df90c3f2140bfbb1122a4bc3'
  INTO STRICT v_definition, v_function_matches
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'ensure_mcp_integration_environment_identity_v1'
    AND p.pronargs = 0;

  IF v_function_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Integration provisioning function does not match the expected predecessor definition'
      USING ERRCODE = 'DI009';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid), c.convalidated
  INTO STRICT v_constraint, v_constraint_validated
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.mcp_environment_identity'::regclass
    AND c.conname = 'mcp_environment_identity_tuple_check'
    AND c.contype = 'c';

  -- Fingerprint the whole validated PostgreSQL 17 predecessor, including its
  -- Production/Preview clauses. Ignore formatting whitespace only; a different
  -- expression or catalog representation must stop for explicit review.
  IF v_constraint_validated IS DISTINCT FROM true
    OR pg_catalog.encode(extensions.digest(
      pg_catalog.regexp_replace(v_constraint, '[[:space:]]', '', 'g'), 'sha256'
    ), 'hex') <> '00d67bca10165d3b5b9eba10c0244ff1134d18b93eb4e7e4d39f99009f418846' THEN
    RAISE EXCEPTION 'Integration tuple constraint does not match the expected predecessor definition'
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
