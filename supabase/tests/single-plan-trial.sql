-- Isolated database only. All fixtures are rolled back; never run on Production.
BEGIN;
DO $test$
DECLARE
  u uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  started timestamptz := '2026-09-08T00:00:00Z';
  affected integer;
  r record;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    (u,u::text || '@example.invalid','{}'),
    (other_user,other_user::text || '@example.invalid','{}');
  UPDATE public.profiles SET app_trial_started_at=started,
    app_trial_ends_at=started+interval '1080 hours'
    WHERE id=u AND subscription_status='free' AND subscription_id IS NULL
      AND app_trial_started_at IS NULL AND app_trial_consumed_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'first start failed'; END IF;
  UPDATE public.profiles SET app_trial_started_at=started+interval '1 hour',
    app_trial_ends_at=started+interval '1081 hours'
    WHERE id=u AND subscription_status='free' AND subscription_id IS NULL
      AND app_trial_started_at IS NULL AND app_trial_consumed_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'second start extended trial'; END IF;
  IF (SELECT app_trial_ends_at FROM public.profiles WHERE id=u) <> started+interval '1080 hours'
    THEN RAISE EXCEPTION 'deadline moved'; END IF;
  UPDATE public.profiles SET subscription_status='canceled' WHERE id=u;
  IF (SELECT app_trial_consumed_at FROM public.profiles WHERE id=u) IS NOT NULL
    THEN RAISE EXCEPTION 'unsuccessful checkout consumed trial'; END IF;
  UPDATE public.profiles SET subscription_status='active' WHERE id=u;
  IF (SELECT app_trial_consumed_at FROM public.profiles WHERE id=u) IS NOT NULL
    THEN RAISE EXCEPTION 'active before payment consumed trial'; END IF;
  UPDATE public.profiles SET app_trial_consumed_at=now() WHERE id=u AND app_trial_consumed_at IS NULL;
  UPDATE public.profiles SET subscription_status='canceled' WHERE id=u;
  IF (SELECT app_trial_consumed_at FROM public.profiles WHERE id=u) IS NULL
    THEN RAISE EXCEPTION 'cancellation restored trial'; END IF;
  FOR r IN SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name LIKE 'app_trial_%'
  LOOP
    IF has_column_privilege('authenticated','public.profiles',r.column_name,'UPDATE')
      OR has_column_privilege('authenticated','public.profiles',r.column_name,'INSERT')
      THEN RAISE EXCEPTION 'trial tampering possible: %',r.column_name; END IF;
  END LOOP;
  INSERT INTO public.categories(id,user_id,name,color) VALUES(c,other_user,'foreign fixture','blue');
  BEGIN
    INSERT INTO public.activities(id,user_id,name,category_id) VALUES(a,u,'cross tenant',c);
    RAISE EXCEPTION 'service-owned insert crossed tenant boundary';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO public.activities(id,user_id,name) VALUES(a,u,'owner fixture');
  PERFORM set_config('request.jwt.claims',json_build_object('sub',u,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS(SELECT 1 FROM public.activities WHERE id=a) THEN RAISE EXCEPTION 'expired read denied'; END IF;
  IF EXISTS(SELECT 1 FROM public.categories WHERE id=c) THEN RAISE EXCEPTION 'foreign read allowed'; END IF;
  BEGIN
    UPDATE public.profiles SET app_trial_consumed_at=NULL WHERE id=u;
    RAISE EXCEPTION 'direct trial tampering succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.activities WHERE id=a;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'expired deletion denied'; END IF;
  RESET ROLE;
END;
$test$;
ROLLBACK;
