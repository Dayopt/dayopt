-- Contract step: deploy the service-owned template write paths before applying.
-- This closes undocumented direct Data API writes even while billing is disabled.
-- SELECT/DELETE and their owner RLS policies remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
REVOKE ALL PRIVILEGES ON public.plan_templates, public.plan_template_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.plan_templates, public.plan_template_blocks TO authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('plan_templates', 'plan_template_blocks')
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON public.%I FROM PUBLIC, anon, authenticated',
      r.column_name, r.column_name, r.column_name, r.table_name);
    IF has_column_privilege('authenticated', format('public.%I', r.table_name), r.column_name, 'INSERT')
      OR has_column_privilege('authenticated', format('public.%I', r.table_name), r.column_name, 'UPDATE') THEN
      RAISE EXCEPTION 'Direct template write capability remains';
    END IF;
  END LOOP;
END;
$$;
COMMIT;
