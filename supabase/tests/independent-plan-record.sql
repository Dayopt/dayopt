-- Run only in an isolated validation database after the independent-writer migration.
-- Fixtures and all mutations are rolled back.
BEGIN;
DO $test$
DECLARE
  u uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  p public.plans%ROWTYPE;
  r public.records%ROWTYPE;
  legacy_record public.records%ROWTYPE;
  a uuid := gen_random_uuid();
  before_plan jsonb;
  before_record jsonb;
  count_created integer;
BEGIN
  INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES (u, u::text || '@example.invalid', '{}'::jsonb);
  INSERT INTO public.plans(user_id, title, start_at, end_at)
    VALUES (u, 'independent fixture', now() - interval '2 days', now() - interval '2 days' + interval '1 hour') RETURNING * INTO p;
  before_plan := to_jsonb(p);
  BEGIN
    PERFORM private.record_plan_unserialized_v1(other_user, p.id, p.updated_at);
    RAISE EXCEPTION 'foreign user could read/copy plan';
  EXCEPTION WHEN SQLSTATE 'DT001' THEN NULL;
  END;
  SELECT * INTO r FROM private.record_plan_unserialized_v1(u, p.id, p.updated_at);
  IF to_jsonb(r) ? 'plan_id' THEN RAISE EXCEPTION 'record still exposes a link column'; END IF;
  IF (SELECT to_jsonb(plan) FROM public.plans plan WHERE id = p.id) IS DISTINCT FROM before_plan THEN
    RAISE EXCEPTION 'copy changed the plan';
  END IF;
  BEGIN
    PERFORM private.record_plan_unserialized_v1(u, p.id, p.updated_at);
    RAISE EXCEPTION 'duplicate time was accepted';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  SELECT * INTO r FROM private.update_record_unserialized_v1(u, r.id, r.updated_at, r.title, r.note, NULL, NULL,
    r.start_at + interval '3 hours', r.end_at + interval '3 hours');
  IF (SELECT to_jsonb(plan) FROM public.plans plan WHERE id = p.id) IS DISTINCT FROM before_plan THEN
    RAISE EXCEPTION 'moving the record changed the plan';
  END IF;
  BEGIN
    PERFORM private.set_plan_skipped_unserialized_v1(u, p.id, p.updated_at, true);
    RAISE EXCEPTION 'retired skip writer was accepted';
  EXCEPTION WHEN SQLSTATE 'DT012' THEN NULL;
  END;
  IF to_jsonb(p) ? 'skipped_at' THEN RAISE EXCEPTION 'plan still exposes skipped state'; END IF;
  before_plan := to_jsonb(p);
  SELECT count(*) INTO count_created FROM private.confirm_day_plans_unserialized_v1(u, p.start_at, p.start_at + interval '1 day');
  IF count_created <> 1 THEN RAISE EXCEPTION 'empty original period was not recordable'; END IF;
  SELECT count(*) INTO count_created FROM private.confirm_day_plans_unserialized_v1(u, p.start_at, p.start_at + interval '1 day');
  IF count_created <> 0 THEN RAISE EXCEPTION 'batch duplicated occupied periods'; END IF;
  INSERT INTO public.plans(user_id,title,start_at,end_at) VALUES
    (u,'partly occupied',p.start_at + interval '6 hours',p.start_at + interval '7 hours');
  INSERT INTO public.records(user_id,title,start_at,end_at,source) VALUES
    (u,'partial record',p.start_at + interval '6 hours 45 minutes',p.start_at + interval '7 hours 15 minutes','manual');
  SELECT count(*) INTO count_created FROM private.confirm_day_plans_unserialized_v1(u, p.start_at, p.start_at + interval '1 day');
  IF count_created <> 0 THEN RAISE EXCEPTION 'partly occupied plan was copied or trimmed'; END IF;
  SELECT * INTO legacy_record FROM private.create_record_unserialized_v1(
    u, 'legacy request', NULL, p.id, NULL, 'manual', p.start_at - interval '4 hours', p.end_at - interval '4 hours'
  );
  IF to_jsonb(legacy_record) ? 'plan_id' THEN RAISE EXCEPTION 'legacy create exposed a link column'; END IF;
  SELECT * INTO legacy_record FROM private.delete_record_unserialized_v1(
    u, legacy_record.id, legacy_record.updated_at
  );
  INSERT INTO public.activities(id,user_id,name) VALUES(a,u,'changed activity');
  SELECT * INTO r FROM private.update_record_unserialized_v1(u, r.id, r.updated_at, r.title, r.note, p.id, NULL,
    r.start_at, r.end_at + interval '30 minutes', a, true);
  IF (SELECT to_jsonb(plan) FROM public.plans plan WHERE id = p.id) IS DISTINCT FROM before_plan THEN
    RAISE EXCEPTION 'resize or activity change mutated the plan';
  END IF;
  SELECT * INTO r FROM private.delete_record_unserialized_v1(u, r.id, r.updated_at);
  IF (SELECT to_jsonb(plan) FROM public.plans plan WHERE id = p.id) IS DISTINCT FROM before_plan THEN
    RAISE EXCEPTION 'record deletion mutated the plan';
  END IF;
  SELECT * INTO r FROM private.restore_record_unserialized_v1(u, r.id, r.updated_at);
  IF (SELECT to_jsonb(plan) FROM public.plans plan WHERE id = p.id) IS DISTINCT FROM before_plan THEN
    RAISE EXCEPTION 'record restore mutated the plan';
  END IF;
  before_record := to_jsonb(r);
  SELECT * INTO p FROM private.update_plan_unserialized_v1(u,p.id,p.updated_at,p.title,p.note,NULL,
    p.start_at - interval '1 hour',p.end_at - interval '30 minutes',a,true);
  IF (SELECT to_jsonb(record) FROM public.records record WHERE id = r.id) IS DISTINCT FROM before_record THEN
    RAISE EXCEPTION 'plan move resize or activity change mutated record';
  END IF;
  before_record := to_jsonb(r);
  PERFORM private.delete_plan_unserialized_v1(u, p.id, p.updated_at);
  IF (SELECT to_jsonb(record) FROM public.records record WHERE id = r.id) IS DISTINCT FROM before_record THEN
    RAISE EXCEPTION 'deleting the plan changed the record';
  END IF;
  UPDATE public.records SET deleted_at = now() WHERE id = r.id RETURNING * INTO r;
  PERFORM private.restore_record_unserialized_v1(u, r.id, r.updated_at);
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id = r.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'record restore depends on deleted plan';
  END IF;
  IF private.undo_field_applicable_v1('skipped_at', 'plan') THEN
    RAISE EXCEPTION 'contract stage accepted a retired Plan receipt field';
  END IF;
END;
$test$;
ROLLBACK;
