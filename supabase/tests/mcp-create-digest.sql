-- Only an isolated validation database. All fixture changes roll back.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'dayopt_mcp_digest_%' THEN
    RAISE EXCEPTION 'Use an isolated dayopt_mcp_digest_* database';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
DO $test$
DECLARE
  app_user_id UUID := gen_random_uuid();
  connection_id UUID;
  access_token_id UUID;
  exchange_result RECORD;
  op UUID;
  result RECORD;
  replay RECORD;
  resource UUID;
  start_time TIMESTAMPTZ := now() - interval '2 days';
  end_time TIMESTAMPTZ := now() - interval '2 days' + interval '1 hour';
  payload JSONB;
  old_digest BYTEA;
  snapshot JSONB;
  tool TEXT;
  original_definition TEXT;
  rollback_definition TEXT;
  after_expiry_op UUID;
BEGIN
  INSERT INTO public.mcp_environment_identity(
    singleton_key,
    environment,
    authorization_server_uri,
    resource_uri
  ) VALUES (
    true,
    'production',
    'https://app.dayopt.app',
    'https://mcp.dayopt.app'
  ) ON CONFLICT (singleton_key) DO NOTHING;

  INSERT INTO public.mcp_mutation_control(
    singleton_key,
    writes_enabled,
    billing_enforced,
    enabled_client_ids,
    revision
  ) VALUES (
    true,
    true,
    false,
    ARRAY['chatgpt'],
    0
  ) ON CONFLICT (singleton_key) DO UPDATE
  SET writes_enabled = true,
      billing_enforced = false,
      enabled_client_ids = ARRAY['chatgpt'],
      revision = 0;

  INSERT INTO auth.users(id, email, raw_user_meta_data)
  VALUES(app_user_id, app_user_id::TEXT || '@example.invalid', '{}');

  UPDATE public.profiles
  SET subscription_status = 'active'
  WHERE id = app_user_id;

  SELECT public.create_oauth_authorization_grant_v2(
    app_user_id,
    'chatgpt',
    'https://mcp.dayopt.app',
    ARRAY['read:entries', 'write:plans', 'write:records'],
    repeat('a', 64),
    'https://chatgpt.com/connector_platform_oauth_redirect',
    repeat('x', 43),
    true
  ) INTO connection_id;

  SELECT * INTO exchange_result
  FROM public.exchange_oauth_authorization_code_v2(
    repeat('a', 64),
    'chatgpt',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://mcp.dayopt.app',
    repeat('x', 43),
    repeat('b', 64),
    repeat('c', 64)
  );
  access_token_id := exchange_result.access_id;


  FOREACH tool IN ARRAY ARRAY['plans.create','records.create'] LOOP
    op := gen_random_uuid();
    -- New writes use v2, keep public schema_version=1 and replay without a second row.
    IF tool = 'plans.create' THEN
      SELECT * INTO result FROM public.apply_mcp_plan_create_v1(connection_id, access_token_id, op, 'digest fixture', NULL, start_time, end_time);
      SELECT * INTO replay FROM public.apply_mcp_plan_create_v1(connection_id, access_token_id, op, 'digest fixture', NULL, start_time, end_time);
    ELSE
      SELECT * INTO result FROM public.apply_mcp_record_create_v1(connection_id, access_token_id, op, 'digest fixture', NULL, NULL, start_time, end_time);
      SELECT * INTO replay FROM public.apply_mcp_record_create_v1(connection_id, access_token_id, op, 'digest fixture', NULL, NULL, start_time, end_time);
    END IF;
    IF result.schema_version <> 1 OR result.replayed OR NOT replay.replayed OR result.resource_id <> replay.resource_id THEN
      RAISE EXCEPTION 'v2 public response/replay mismatch: %', tool;
    END IF;
    IF (SELECT digest_version FROM public.mcp_mutation_receipts WHERE operation_id=op) <> 2 THEN
      RAISE EXCEPTION 'new receipt is not v2: %', tool;
    END IF;
    BEGIN
      IF tool = 'plans.create' THEN
        PERFORM public.apply_mcp_plan_create_v1(connection_id, access_token_id, op, 'changed input', NULL, start_time, end_time);
      ELSE
        PERFORM public.apply_mcp_record_create_v1(connection_id, access_token_id, op, 'changed input', NULL, NULL, start_time, end_time);
      END IF;
      RAISE EXCEPTION 'changed input replayed: %', tool;
    EXCEPTION WHEN SQLSTATE 'DM006' THEN NULL; END;
    BEGIN
      UPDATE public.mcp_mutation_receipts SET digest_version=1 WHERE operation_id=op;
      RAISE EXCEPTION 'digest format was mutable';
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;

    -- A distinct historical receipt with the exact v1 payload. Never rewrite a receipt.
    payload := jsonb_build_object('title','digest fixture','note',NULL::TEXT,
      'tagId',NULL::UUID,'externalCalendarEventId',NULL::UUID,'source','api',
      'startAt',to_char(start_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'endAt',to_char(end_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    IF tool='records.create' THEN payload := payload || jsonb_build_object('planId',NULL::UUID); END IF;
    old_digest := private.digest_mcp_mutation_envelope_v1(tool,payload);
    op := gen_random_uuid();
    INSERT INTO public.mcp_mutation_receipts(user_id,client_id,operation_id,origin_connection_id,envelope_version,tool_name,request_digest,resource_type,resource_id,resource_version,resource_deleted_at)
      VALUES(app_user_id,'chatgpt',op,connection_id,1,tool,old_digest,result.resource_type,result.resource_id,result.version,NULL);
    SELECT to_jsonb(r) INTO snapshot FROM public.mcp_mutation_receipts r WHERE operation_id=op;
    IF tool='plans.create' THEN
      SELECT * INTO replay FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,start_time,end_time);
    ELSE
      SELECT * INTO replay FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,NULL,start_time,end_time);
    END IF;
    IF NOT replay.replayed OR replay.resource_id <> result.resource_id OR
      (SELECT to_jsonb(r) FROM public.mcp_mutation_receipts r WHERE operation_id=op) IS DISTINCT FROM snapshot THEN
      RAISE EXCEPTION 'legacy replay failed or rewrote receipt: %',tool;
    END IF;
    BEGIN
      IF tool='plans.create' THEN
        PERFORM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'changed legacy',NULL,start_time,end_time);
      ELSE
        PERFORM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'changed legacy',NULL,NULL,start_time,end_time);
      END IF;
      RAISE EXCEPTION 'changed legacy input accepted';
    EXCEPTION WHEN SQLSTATE 'DM006' THEN NULL; END;
    -- Authorization must precede replay even when the result was already committed.
    UPDATE public.oauth_tokens SET revoked_at=now() WHERE id=access_token_id;
    BEGIN
      IF tool='plans.create' THEN
        PERFORM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,start_time,end_time);
      ELSE
        PERFORM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,NULL,start_time,end_time);
      END IF;
      RAISE EXCEPTION 'revoked token replayed';
    EXCEPTION WHEN SQLSTATE 'DM004' THEN NULL; END;
    UPDATE public.oauth_tokens SET revoked_at=NULL WHERE id=access_token_id;
    -- Historic timestamps are fixture construction only, in this isolated database.
    ALTER TABLE public.mcp_mutation_receipts DISABLE TRIGGER USER;
    UPDATE public.mcp_mutation_receipts SET applied_at=clock_timestamp()-interval '90 days'+interval '1 hour' WHERE operation_id=op;
    ALTER TABLE public.mcp_mutation_receipts ENABLE TRIGGER USER;
    IF tool='plans.create' THEN
      SELECT * INTO replay FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,start_time,end_time);
    ELSE
      SELECT * INTO replay FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,NULL,start_time,end_time);
    END IF;
    IF NOT replay.replayed THEN RAISE EXCEPTION 'receipt inside retention was not replayed'; END IF;
    UPDATE public.mcp_mutation_receipts SET purged_generation=data_generation+1,purged_at=now(),resource_deleted_at=now() WHERE operation_id=op;
    BEGIN
      IF tool='plans.create' THEN
        PERFORM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,start_time,end_time);
      ELSE
        PERFORM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'digest fixture',NULL,NULL,start_time,end_time);
      END IF;
      RAISE EXCEPTION 'purged receipt replayed';
    EXCEPTION WHEN SQLSTATE 'DM008' THEN NULL; END;
    ALTER TABLE public.mcp_mutation_receipts DISABLE TRIGGER USER;
    UPDATE public.mcp_mutation_receipts SET applied_at=clock_timestamp()-interval '90 days'-interval '1 hour' WHERE operation_id=op;
    ALTER TABLE public.mcp_mutation_receipts ENABLE TRIGGER USER;
    IF tool='plans.create' THEN
      SELECT * INTO result FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'new after expiry',NULL,start_time-interval '10 days',end_time-interval '10 days');
    ELSE
      SELECT * INTO result FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'new after expiry',NULL,NULL,start_time-interval '10 days',end_time-interval '10 days');
    END IF;
    IF result.replayed OR (SELECT digest_version FROM public.mcp_mutation_receipts WHERE operation_id=op) <> 2 THEN
      RAISE EXCEPTION 'expired legacy receipt did not become a fresh v2 write';
    END IF;
    after_expiry_op := op;

    -- Rollback drill: keep dual-format readers and change only NEW emission to v1.
    SELECT pg_get_functiondef(p.oid) INTO STRICT original_definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=CASE WHEN tool='plans.create' THEN 'apply_mcp_plan_create_v1' ELSE 'apply_mcp_record_create_v1' END;
    rollback_definition := replace(original_definition,E'    v_request_digest,\n    2,\n',E'    v_legacy_digest,\n    1,\n');
    IF rollback_definition=original_definition THEN RAISE EXCEPTION 'rollback writer replacement did not match'; END IF;
    EXECUTE rollback_definition;
    op := gen_random_uuid();
    IF tool='plans.create' THEN
      SELECT * INTO result FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'rollback fixture',NULL,start_time-interval '20 days',end_time-interval '20 days');
      SELECT * INTO replay FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,after_expiry_op,'new after expiry',NULL,start_time-interval '10 days',end_time-interval '10 days');
    ELSE
      SELECT * INTO result FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'rollback fixture',NULL,NULL,start_time-interval '20 days',end_time-interval '20 days');
      SELECT * INTO replay FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,after_expiry_op,'new after expiry',NULL,NULL,start_time-interval '10 days',end_time-interval '10 days');
    END IF;
    IF NOT replay.replayed OR (SELECT digest_version FROM public.mcp_mutation_receipts WHERE operation_id=op) <> 1 THEN
      RAISE EXCEPTION 'rollback must emit v1 and replay v2';
    END IF;
    EXECUTE original_definition;
    IF tool='plans.create' THEN
      SELECT * INTO replay FROM public.apply_mcp_plan_create_v1(connection_id,access_token_id,op,'rollback fixture',NULL,start_time-interval '20 days',end_time-interval '20 days');
    ELSE
      SELECT * INTO replay FROM public.apply_mcp_record_create_v1(connection_id,access_token_id,op,'rollback fixture',NULL,NULL,start_time-interval '20 days',end_time-interval '20 days');
    END IF;
    IF NOT replay.replayed THEN RAISE EXCEPTION 'roll-forward failed to replay rollback receipt'; END IF;
    RAISE NOTICE 'PASS %: new/legacy replay, input/auth/immutability, retention, purge, rollback and roll-forward',tool;
  END LOOP;
  IF has_function_privilege('anon','private.resolve_mcp_create_replay_v2(uuid,text,uuid,text,bytea,bytea,text)','EXECUTE')
    OR has_function_privilege('service_role','private.resolve_mcp_create_replay_v2(uuid,text,uuid,text,bytea,bytea,text)','EXECUTE') THEN
    RAISE EXCEPTION 'private replay helper exposed';
  END IF;
END;
$test$;
ROLLBACK;
