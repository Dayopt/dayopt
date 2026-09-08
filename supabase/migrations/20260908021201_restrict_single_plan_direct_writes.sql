-- Contract step: the service-owned writers from PR #2663 must be live first.
-- Keep SELECT/DELETE available after the paid access window so users can read
-- and remove their own data, while closing direct Data API write bypasses.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL PRIVILEGES ON
  public.activities,
  public.categories,
  public.segments,
  public.segment_activities,
  public.plan_templates,
  public.plan_template_blocks
FROM PUBLIC, anon, authenticated;

GRANT SELECT, DELETE ON
  public.activities,
  public.categories,
  public.segments,
  public.segment_activities,
  public.plan_templates,
  public.plan_template_blocks
TO authenticated;

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'activities',
        'categories',
        'segments',
        'segment_activities',
        'plan_templates',
        'plan_template_blocks'
      )
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON public.%I FROM PUBLIC, anon, authenticated',
      target.column_name,
      target.column_name,
      target.column_name,
      target.table_name
    );

    IF has_column_privilege(
      'authenticated',
      format('public.%I', target.table_name),
      target.column_name,
      'INSERT'
    ) OR has_column_privilege(
      'authenticated',
      format('public.%I', target.table_name),
      target.column_name,
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'Direct write capability remains on %.%',
        target.table_name,
        target.column_name;
    END IF;
  END LOOP;
END;
$$;

-- Emergency recovery is deliberately unavailable to application roles. It
-- restores the exact grants that existed before this migration.
CREATE FUNCTION private.restore_single_plan_direct_write_grants_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.activities,
    public.categories,
    public.segments,
    public.plan_templates
  TO authenticated;

  GRANT SELECT, INSERT, DELETE ON
    public.segment_activities,
    public.plan_template_blocks
  TO authenticated;
END;
$$;

REVOKE ALL ON FUNCTION private.restore_single_plan_direct_write_grants_v1()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.restore_single_plan_direct_write_grants_v1()
TO postgres;

COMMIT;
