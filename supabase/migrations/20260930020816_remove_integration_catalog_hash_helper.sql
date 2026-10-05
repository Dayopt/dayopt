-- Remove only the exact temporary helper; leave pgcrypto-owned functions alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $migration$
DECLARE
  v_oid oid := pg_catalog.to_regprocedure('extensions.digest(text,text)');
BEGIN
  IF v_oid IS NULL THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    WHERE d.classid = 'pg_proc'::regclass AND d.objid = v_oid
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e' AND e.extname = 'pgcrypto'
  ) THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = v_oid AND p.proowner = current_user::regrole
      AND NOT p.prosecdef AND p.proisstrict AND p.provolatile = 'i'
      AND p.proconfig = ARRAY['search_path=""']::text[]
      AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
        = '8dd0f34a9862974db7b0eb0be237a0b282bdf28fd8391d2bb0bdc9999f9dbaf4'
      AND pg_catalog.obj_description(p.oid, 'pg_proc')
        = 'Dayopt migration-only catalog SHA-256 compatibility 2937'
  ) THEN
    RAISE EXCEPTION 'Temporary catalog hash helper differs' USING ERRCODE = 'DI009';
  END IF;
  DROP FUNCTION extensions.digest(text,text);
END
$migration$;
COMMIT;
