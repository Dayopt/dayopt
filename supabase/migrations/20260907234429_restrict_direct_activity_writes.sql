-- Contract step: deploy the service-owned activity/segment write paths before applying.
-- This closes undocumented direct Data API writes even while billing is disabled.
-- SELECT/DELETE and their owner RLS policies remain unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
REVOKE ALL PRIVILEGES ON public.activities, public.categories, public.segments,
  public.segment_activities FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.activities, public.categories, public.segments,
  public.segment_activities TO authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('activities', 'categories', 'segments', 'segment_activities')
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON public.%I FROM PUBLIC, anon, authenticated',
      r.column_name, r.column_name, r.column_name, r.table_name);
    IF has_column_privilege('authenticated', format('public.%I', r.table_name), r.column_name, 'INSERT')
      OR has_column_privilege('authenticated', format('public.%I', r.table_name), r.column_name, 'UPDATE') THEN
      RAISE EXCEPTION 'Direct activity/segment write capability remains';
    END IF;
  END LOOP;
END;
$$;
COMMIT;
