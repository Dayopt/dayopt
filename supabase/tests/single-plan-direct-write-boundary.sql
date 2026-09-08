-- Isolated database. Recovery verification is rolled back.
BEGIN;

DO $test$
DECLARE
  target_table text;
  target_column text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'activities',
    'categories',
    'segments',
    'segment_activities',
    'plan_templates',
    'plan_template_blocks'
  ]
  LOOP
    IF has_table_privilege('authenticated', format('public.%I', target_table), 'INSERT')
      OR has_table_privilege('authenticated', format('public.%I', target_table), 'UPDATE') THEN
      RAISE EXCEPTION 'authenticated retains direct write on %', target_table;
    END IF;

    IF NOT has_table_privilege('authenticated', format('public.%I', target_table), 'SELECT')
      OR NOT has_table_privilege('authenticated', format('public.%I', target_table), 'DELETE') THEN
      RAISE EXCEPTION 'authenticated lost read/delete access on %', target_table;
    END IF;

    FOR target_column IN
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target_table
    LOOP
      IF has_column_privilege(
        'authenticated',
        format('public.%I', target_table),
        target_column,
        'INSERT'
      ) OR has_column_privilege(
        'authenticated',
        format('public.%I', target_table),
        target_column,
        'UPDATE'
      ) THEN
        RAISE EXCEPTION 'authenticated retains column write on %.%',
          target_table,
          target_column;
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege(
    'authenticated',
    'private.restore_single_plan_direct_write_grants_v1()',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'private.restore_single_plan_direct_write_grants_v1()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'application role can execute grant recovery';
  END IF;
END;
$test$;

SELECT private.restore_single_plan_direct_write_grants_v1();

DO $test$
DECLARE
  mutable_table text;
  append_only_table text;
  required_privilege text;
BEGIN
  FOREACH mutable_table IN ARRAY ARRAY[
    'activities',
    'categories',
    'segments',
    'plan_templates'
  ]
  LOOP
    FOREACH required_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    LOOP
      IF NOT has_table_privilege(
        'authenticated',
        format('public.%I', mutable_table),
        required_privilege
      ) THEN
        RAISE EXCEPTION 'recovery did not restore % on %',
          required_privilege,
          mutable_table;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH append_only_table IN ARRAY ARRAY[
    'segment_activities',
    'plan_template_blocks'
  ]
  LOOP
    FOREACH required_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE']
    LOOP
      IF NOT has_table_privilege(
        'authenticated',
        format('public.%I', append_only_table),
        required_privilege
      ) THEN
        RAISE EXCEPTION 'recovery did not restore % on %',
          required_privilege,
          append_only_table;
      END IF;
    END LOOP;

    IF has_table_privilege(
      'authenticated',
      format('public.%I', append_only_table),
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'recovery restored extra UPDATE on %', append_only_table;
    END IF;
  END LOOP;
END;
$test$;

ROLLBACK;
