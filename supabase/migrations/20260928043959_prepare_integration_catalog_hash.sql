-- Temporary migration-only compatibility for immutable Integration migrations.
-- Production pgcrypto lives in auth; do not move the extension or expose a new RPC.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('extensions.digest(text,text)') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = 'extensions.digest(text,text)'::regprocedure
        AND d.refclassid = 'pg_extension'::regclass
        AND d.deptype = 'e' AND e.extname = 'pgcrypto'
    ) THEN
      RAISE EXCEPTION 'Catalog hash predecessor differs' USING ERRCODE = 'DI009';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'auth'
  ) THEN
    RAISE EXCEPTION 'Catalog hash extension location differs' USING ERRCODE = 'DI009';
  END IF;
  EXECUTE $create$CREATE FUNCTION extensions.digest(value text, algorithm text)
    RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
    SET search_path = '' AS $body$
BEGIN
  IF algorithm <> 'sha256' THEN
    RAISE EXCEPTION 'Temporary catalog hash supports SHA-256 only';
  END IF;
  RETURN pg_catalog.sha256(pg_catalog.convert_to(value, 'UTF8'));
END
$body$$create$;
  COMMENT ON FUNCTION extensions.digest(text,text)
    IS 'Dayopt migration-only catalog SHA-256 compatibility 2937';
  REVOKE ALL ON FUNCTION extensions.digest(text,text)
    FROM PUBLIC, anon, authenticated, service_role;
END
$migration$;
COMMIT;
