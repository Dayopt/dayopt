-- Phase 1: independent writers. Existing relation columns remain inert until contraction.
-- Function bodies preserve the existing writer fence, owner checks and receipt digests.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.plans, public.records IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.records DROP CONSTRAINT IF EXISTS records_plan_id_fkey;
DROP TRIGGER IF EXISTS enforce_record_plan_owner ON public.records;
DROP TRIGGER IF EXISTS enforce_active_record_plan_v1 ON public.records;
DROP TRIGGER IF EXISTS enforce_plan_skip_record_invariant_v1 ON public.plans;
ALTER TABLE public.records DROP CONSTRAINT IF EXISTS records_from_plan_source_shape;
DROP INDEX IF EXISTS public.records_one_active_from_plan_per_plan_idx;

CREATE OR REPLACE FUNCTION private.create_record_unserialized_v1(p_user_id uuid, p_title text, p_note text, p_plan_id uuid, p_external_calendar_event_id uuid, p_source text, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_activity_id uuid DEFAULT NULL::uuid, p_fulfillment text DEFAULT NULL::text)
 RETURNS SETOF records
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.assert_timeblock_content_v1(p_title, p_note);
  PERFORM public.assert_active_timeblock_activity_v1(p_user_id, p_activity_id);
  PERFORM public.assert_timeblock_external_event_v1(
    p_user_id,
    p_external_calendar_event_id
  );
  IF p_plan_id IS NOT NULL THEN
    RAISE EXCEPTION 'Plan links have been removed; omit planId when creating a Record' USING ERRCODE = 'DT012';
  END IF;

  IF p_source IS NULL
    OR p_source <> ALL (ARRAY['manual', 'external_calendar', 'api']::TEXT[])
    OR ((p_source = 'external_calendar') IS DISTINCT FROM
        (p_external_calendar_event_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid Record source shape' USING ERRCODE = 'DT012';
  END IF;

  IF p_fulfillment IS NOT NULL
    AND p_fulfillment <> ALL (ARRAY['low', 'medium', 'high']::TEXT[]) THEN
    RAISE EXCEPTION 'Invalid Record fulfillment value' USING ERRCODE = 'DT012';
  END IF;

  RETURN QUERY
  INSERT INTO public.records (
    user_id, title, note, activity_id, external_calendar_event_id,
    source, start_at, end_at, fulfillment
  ) VALUES (
    p_user_id, p_title, p_note, p_activity_id,
    p_external_calendar_event_id, p_source, p_start_at, p_end_at, p_fulfillment
  )
  RETURNING public.records.*;
END;
$function$;

CREATE OR REPLACE FUNCTION private.update_record_unserialized_v1(p_user_id uuid, p_record_id uuid, p_expected_updated_at timestamp with time zone, p_title text, p_note text, p_plan_id uuid, p_external_calendar_event_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_activity_id uuid DEFAULT NULL::uuid, p_activity_id_present boolean DEFAULT false, p_fulfillment text DEFAULT NULL::text, p_fulfillment_present boolean DEFAULT false)
 RETURNS SETOF records
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_record public.records%ROWTYPE;
  v_next_activity_id uuid;
  v_next_fulfillment text;
BEGIN
  SELECT record.* INTO v_record
  FROM public.records AS record
  WHERE record.id = p_record_id
    AND record.user_id = p_user_id
    AND record.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'DT001';
  END IF;
  IF p_expected_updated_at IS NULL
    OR v_record.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Record version conflict' USING ERRCODE = 'DT002';
  END IF;
  IF v_record.source = 'auto_migrated' THEN
    RAISE EXCEPTION 'Migrated Record is immutable' USING ERRCODE = 'DT009';
  END IF;
  IF ((v_record.source = 'external_calendar') IS DISTINCT FROM
      (p_external_calendar_event_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid Record source shape' USING ERRCODE = 'DT012';
  END IF;

  -- present=false は「触らない」（旧バンドルの更新で activity_id / fulfillment を消さない）。
  v_next_activity_id := CASE
    WHEN p_activity_id_present THEN p_activity_id
    ELSE v_record.activity_id
  END;
  v_next_fulfillment := CASE
    WHEN p_fulfillment_present THEN p_fulfillment
    ELSE v_record.fulfillment
  END;

  IF p_fulfillment_present
    AND v_next_fulfillment IS NOT NULL
    AND v_next_fulfillment <> ALL (ARRAY['low', 'medium', 'high']::TEXT[]) THEN
    RAISE EXCEPTION 'Invalid Record fulfillment value' USING ERRCODE = 'DT012';
  END IF;

  IF p_plan_id IS NOT NULL THEN
    RAISE EXCEPTION 'Plan links have been removed; omit planId when updating a Record' USING ERRCODE = 'DT012';
  END IF;

  PERFORM public.assert_timeblock_content_v1(p_title, p_note);
  IF v_next_activity_id IS DISTINCT FROM v_record.activity_id THEN
    PERFORM public.assert_active_timeblock_activity_v1(p_user_id, v_next_activity_id);
  END IF;
  IF p_external_calendar_event_id IS DISTINCT FROM v_record.external_calendar_event_id THEN
    PERFORM public.assert_timeblock_external_event_v1(
      p_user_id,
      p_external_calendar_event_id
    );
  END IF;

  IF ROW(
    p_title,
    p_note,
    v_next_activity_id,
    p_external_calendar_event_id,
    p_start_at,
    p_end_at,
    v_next_fulfillment
  ) IS NOT DISTINCT FROM ROW(
    v_record.title,
    v_record.note,
    v_record.activity_id,
    v_record.external_calendar_event_id,
    v_record.start_at,
    v_record.end_at,
    v_record.fulfillment
  ) THEN
    RETURN NEXT v_record;
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.records
  SET title = p_title,
      note = p_note,
      activity_id = v_next_activity_id,
      external_calendar_event_id = p_external_calendar_event_id,
      start_at = p_start_at,
      end_at = p_end_at,
      fulfillment = v_next_fulfillment
  WHERE id = p_record_id
    AND user_id = p_user_id
    AND deleted_at IS NULL
  RETURNING public.records.*;
END;
$function$;

CREATE OR REPLACE FUNCTION private.restore_record_unserialized_v1(p_user_id uuid, p_record_id uuid, p_expected_updated_at timestamp with time zone)
 RETURNS SETOF records
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_record public.records%ROWTYPE;
BEGIN
  SELECT record.*
  INTO v_record
  FROM public.records AS record
  WHERE record.id = p_record_id
    AND record.user_id = p_user_id
    AND record.deleted_at IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'DT001';
  END IF;
  IF p_expected_updated_at IS NULL
    OR v_record.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Record version conflict' USING ERRCODE = 'DT002';
  END IF;
  IF v_record.source = 'auto_migrated' THEN
    RAISE EXCEPTION 'Migrated Record is immutable' USING ERRCODE = 'DT009';
  END IF;

  RETURN QUERY
  UPDATE public.records
  SET deleted_at = NULL
  WHERE id = p_record_id
    AND user_id = p_user_id
    AND deleted_at IS NOT NULL
  RETURNING public.records.*;
END;
$function$;

CREATE OR REPLACE FUNCTION private.record_plan_unserialized_v1(p_user_id uuid, p_plan_id uuid, p_expected_updated_at timestamp with time zone)
 RETURNS SETOF records
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_plan public.plans%ROWTYPE;
BEGIN
  v_plan := public.lock_recordable_plan_v1(p_user_id, p_plan_id);

  IF p_expected_updated_at IS NULL
    OR v_plan.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Plan version conflict' USING ERRCODE = 'DT002';
  END IF;
  RETURN QUERY
  INSERT INTO public.records (
    user_id, title, note, activity_id, external_calendar_event_id,
    source, start_at, end_at
  ) VALUES (
    p_user_id,
    v_plan.title,
    v_plan.note,
    v_plan.activity_id,
    NULL,
    'from_plan',
    v_plan.start_at,
    v_plan.end_at
  )
  RETURNING public.records.*;
END;
$function$;

CREATE OR REPLACE FUNCTION private.confirm_day_plans_unserialized_v1(p_user_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_confirmed_at timestamp with time zone DEFAULT now())
 RETURNS SETOF records
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_confirmed_at CONSTANT TIMESTAMPTZ := LEAST(
    COALESCE(p_confirmed_at, pg_catalog.now()),
    pg_catalog.now()
  );
  v_plan public.plans%ROWTYPE;
  v_record public.records%ROWTYPE;
BEGIN
  IF p_end_at IS NULL OR p_start_at IS NULL OR p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'Confirm day range end must be after start'
      USING ERRCODE = 'DT003';
  END IF;
  IF p_end_at - p_start_at > INTERVAL '26 hours' THEN
    RAISE EXCEPTION 'Confirm day range must not exceed 26 hours'
      USING ERRCODE = '22023';
  END IF;

  FOR v_plan IN
    SELECT plan.*
    FROM public.plans AS plan
    WHERE plan.user_id = p_user_id
      AND plan.deleted_at IS NULL
      AND plan.end_at <= v_confirmed_at
      AND plan.start_at >= p_start_at
      AND plan.start_at < p_end_at
    ORDER BY plan.start_at, plan.id
    FOR UPDATE OF plan
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1
      FROM public.records AS record
      WHERE record.user_id = p_user_id
        AND record.start_at < v_plan.end_at
        AND record.end_at > v_plan.start_at
        AND record.deleted_at IS NULL
    );

    INSERT INTO public.records (
      user_id,
      activity_id,
      external_calendar_event_id,
      title,
      note,
      start_at,
      end_at,
      source,
      created_at,
      updated_at
    ) VALUES (
      v_plan.user_id,
      v_plan.activity_id,
      NULL,
      v_plan.title,
      v_plan.note,
      v_plan.start_at,
      v_plan.end_at,
      'from_plan',
      v_confirmed_at,
      v_confirmed_at
    )
    RETURNING public.records.* INTO v_record;

    RETURN NEXT v_record;
  END LOOP;

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lock_recordable_plan_v1(p_user_id uuid, p_plan_id uuid)
 RETURNS plans
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_plan public.plans%ROWTYPE;
BEGIN
  SELECT plan.*
  INTO v_plan
  FROM public.plans AS plan
  WHERE plan.id = p_plan_id
    AND plan.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_plan.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Plan not found' USING ERRCODE = 'DT001';
  END IF;

  RETURN v_plan;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_mcp_record_update_v1(p_connection_id uuid, p_access_token_id uuid, p_operation_id uuid, p_record_id uuid, p_expected_updated_at timestamp with time zone, p_title_present boolean, p_title text, p_note_present boolean, p_note text, p_start_at_present boolean, p_start_at timestamp with time zone, p_end_at_present boolean, p_end_at timestamp with time zone, p_activity_id_present boolean DEFAULT false, p_activity_id uuid DEFAULT NULL::uuid, p_fulfillment_present boolean DEFAULT false, p_fulfillment text DEFAULT NULL::text)
 RETURNS TABLE(schema_version smallint, operation_id uuid, resource_type text, resource_id uuid, version timestamp with time zone, deleted_at timestamp with time zone, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_user_id UUID;
  v_client_id TEXT;
  v_authority_expires_at TIMESTAMPTZ;
  v_normalized_args JSONB;
  v_request_digest BYTEA;
  v_receipt public.mcp_mutation_receipts%ROWTYPE;
  v_existing public.records%ROWTYPE;
  v_record public.records%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_connection_id IS NULL
    OR p_access_token_id IS NULL
    OR p_operation_id IS NULL
    OR p_record_id IS NULL
    OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'MCP Record update input is incomplete'
      USING ERRCODE = '22004';
  END IF;

  IF p_title_present IS NULL
    OR p_note_present IS NULL
    OR p_activity_id_present IS NULL
    OR p_fulfillment_present IS NULL
    OR p_start_at_present IS NULL
    OR p_end_at_present IS NULL THEN
    RAISE EXCEPTION 'MCP Record update field presence is incomplete'
      USING ERRCODE = '22004';
  END IF;

  IF NOT p_title_present
    AND NOT p_note_present
    AND NOT p_activity_id_present
    AND NOT p_fulfillment_present
    AND NOT p_start_at_present
    AND NOT p_end_at_present THEN
    RAISE EXCEPTION 'MCP Record update patch is empty'
      USING ERRCODE = '22023';
  END IF;

  IF (p_title_present AND p_title IS NULL)
    OR (NOT p_title_present AND p_title IS NOT NULL)
    OR (NOT p_note_present AND p_note IS NOT NULL)
    OR (NOT p_activity_id_present AND p_activity_id IS NOT NULL)
    OR (NOT p_fulfillment_present AND p_fulfillment IS NOT NULL)
    OR (p_start_at_present AND p_start_at IS NULL)
    OR (NOT p_start_at_present AND p_start_at IS NOT NULL)
    OR (p_end_at_present AND p_end_at IS NULL)
    OR (NOT p_end_at_present AND p_end_at IS NOT NULL) THEN
    RAISE EXCEPTION 'MCP Record update patch shape is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_catalog.isfinite(p_expected_updated_at)
    OR (p_start_at_present AND NOT pg_catalog.isfinite(p_start_at))
    OR (p_end_at_present AND NOT pg_catalog.isfinite(p_end_at)) THEN
    RAISE EXCEPTION 'MCP Record update timestamps must be finite'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    auth_result.user_id,
    auth_result.client_id,
    auth_result.authority_expires_at
  INTO v_user_id, v_client_id, v_authority_expires_at
  FROM private.authorize_mcp_mutation_v1(
    p_connection_id,
    p_access_token_id,
    'write:records'::TEXT,
    p_operation_id
  ) AS auth_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  v_normalized_args := pg_catalog.jsonb_build_object(
    'recordId', p_record_id,
    'expectedUpdatedAt', pg_catalog.to_char(
      p_expected_updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );

  IF p_title_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object('title', p_title);
  END IF;
  IF p_note_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object('note', p_note);
  END IF;
  IF p_activity_id_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object('activityId', p_activity_id);
  END IF;
  IF p_fulfillment_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object('fulfillment', p_fulfillment);
  END IF;
  IF p_start_at_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object(
        'startAt', pg_catalog.to_char(
          p_start_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      );
  END IF;
  IF p_end_at_present THEN
    v_normalized_args := v_normalized_args
      || pg_catalog.jsonb_build_object(
        'endAt', pg_catalog.to_char(
          p_end_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      );
  END IF;

  v_request_digest := private.digest_mcp_mutation_envelope_v1(
    'records.update'::TEXT,
    v_normalized_args
  );

  SELECT replay_receipt.*
  INTO v_receipt
  FROM private.resolve_mcp_mutation_replay_v1(
    v_user_id,
    v_client_id,
    p_operation_id,
    'records.update'::TEXT,
    v_request_digest,
    1::SMALLINT,
    'record'::TEXT
  ) AS replay_receipt;

  IF v_authority_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  IF FOUND THEN
    IF v_receipt.resource_id IS DISTINCT FROM p_record_id
      OR v_receipt.resource_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'MCP mutation receipt invariant failed'
        USING ERRCODE = 'DM007';
    END IF;

    RETURN QUERY SELECT
      v_receipt.envelope_version,
      v_receipt.operation_id,
      v_receipt.resource_type,
      v_receipt.resource_id,
      v_receipt.resource_version,
      v_receipt.resource_deleted_at,
      true;
    RETURN;
  END IF;

  SELECT record.*
  INTO v_existing
  FROM public.records AS record
  WHERE record.id = p_record_id
    AND record.user_id = v_user_id
    AND record.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'DT001';
  END IF;

  IF v_authority_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  -- Public MCP updates cannot alter Plan attribution, source, or external
  -- calendar provenance. Those values pass through from the locked row.
  SELECT record.*
  INTO v_record
  FROM public.update_record_command_v1(
    v_user_id,
    p_record_id,
    p_expected_updated_at,
    CASE WHEN p_title_present THEN p_title ELSE v_existing.title END,
    CASE WHEN p_note_present THEN p_note ELSE v_existing.note END,
    NULL::UUID,
    v_existing.external_calendar_event_id,
    CASE WHEN p_start_at_present THEN p_start_at ELSE v_existing.start_at END,
    CASE WHEN p_end_at_present THEN p_end_at ELSE v_existing.end_at END,
    CASE WHEN p_activity_id_present THEN p_activity_id ELSE v_existing.activity_id END,
    TRUE,
    CASE WHEN p_fulfillment_present THEN p_fulfillment ELSE v_existing.fulfillment END,
    TRUE
  ) AS record;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record command returned no row'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_record.id IS DISTINCT FROM p_record_id
    OR v_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'MCP mutation result invariant failed'
      USING ERRCODE = 'DM007';
  END IF;

  IF v_authority_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  INSERT INTO public.mcp_mutation_receipts (
    user_id,
    client_id,
    operation_id,
    origin_connection_id,
    envelope_version,
    tool_name,
    request_digest,
    resource_type,
    resource_id,
    resource_version,
    resource_deleted_at
  ) VALUES (
    v_user_id,
    v_client_id,
    p_operation_id,
    p_connection_id,
    1,
    'records.update',
    v_request_digest,
    'record',
    v_record.id,
    v_record.updated_at,
    v_record.deleted_at
  )
  RETURNING * INTO v_receipt;

  RETURN QUERY SELECT
    v_receipt.envelope_version,
    v_receipt.operation_id,
    v_receipt.resource_type,
    v_receipt.resource_id,
    v_receipt.resource_version,
    v_receipt.resource_deleted_at,
    false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_mcp_record_create_v1(p_connection_id uuid, p_access_token_id uuid, p_operation_id uuid, p_title text, p_note text, p_plan_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_activity_id uuid DEFAULT NULL::uuid, p_fulfillment text DEFAULT NULL::text)
 RETURNS TABLE(schema_version smallint, operation_id uuid, resource_type text, resource_id uuid, version timestamp with time zone, deleted_at timestamp with time zone, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_user_id UUID;
  v_client_id TEXT;
  v_authority_expires_at TIMESTAMPTZ;
  v_request_digest BYTEA;
  v_receipt public.mcp_mutation_receipts%ROWTYPE;
  v_record public.records%ROWTYPE;
BEGIN
  IF p_plan_id IS NOT NULL THEN
    RAISE EXCEPTION 'Plan links have been removed; omit planId and refresh the tool schema' USING ERRCODE = 'DT012';
  END IF;
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_connection_id IS NULL
    OR p_access_token_id IS NULL
    OR p_operation_id IS NULL
    OR p_start_at IS NULL
    OR p_end_at IS NULL THEN
    RAISE EXCEPTION 'MCP Record create input is incomplete'
      USING ERRCODE = '22004';
  END IF;

  IF NOT pg_catalog.isfinite(p_start_at) OR NOT pg_catalog.isfinite(p_end_at) THEN
    RAISE EXCEPTION 'MCP Record timestamps must be finite'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    auth_result.user_id,
    auth_result.client_id,
    auth_result.authority_expires_at
  INTO v_user_id, v_client_id, v_authority_expires_at
  FROM private.authorize_mcp_mutation_v1(
    p_connection_id,
    p_access_token_id,
    'write:records'::TEXT,
    p_operation_id
  ) AS auth_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  -- ★ 'tagId' は now-removed パラメータの固定値（常に NULL）。20260818140100 と
  --   同じ規律で、deploy 前に発行済みの receipt の digest と一致させるためだけに
  --   キー自体は残す。
  v_request_digest := private.digest_mcp_mutation_envelope_v1(
    'records.create'::TEXT,
    pg_catalog.jsonb_build_object(
      'title', p_title,
      'note', p_note,
      'tagId', NULL::UUID,
      'planId', p_plan_id,
      'externalCalendarEventId', NULL::UUID,
      'source', 'api',
      'startAt', pg_catalog.to_char(
        p_start_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'endAt', pg_catalog.to_char(
        p_end_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
    || CASE
         WHEN p_activity_id IS NULL THEN '{}'::JSONB
         ELSE pg_catalog.jsonb_build_object('activityId', p_activity_id)
       END
    || CASE
         WHEN p_fulfillment IS NULL THEN '{}'::JSONB
         ELSE pg_catalog.jsonb_build_object('fulfillment', p_fulfillment)
       END
  );

  SELECT replay_receipt.*
  INTO v_receipt
  FROM private.resolve_mcp_mutation_replay_v1(
    v_user_id,
    v_client_id,
    p_operation_id,
    'records.create'::TEXT,
    v_request_digest,
    1::SMALLINT,
    'record'::TEXT
  ) AS replay_receipt;

  IF v_authority_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  IF FOUND THEN
    IF v_receipt.resource_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'MCP mutation receipt invariant failed'
        USING ERRCODE = 'DM007';
    END IF;

    RETURN QUERY SELECT
      v_receipt.envelope_version,
      v_receipt.operation_id,
      v_receipt.resource_type,
      v_receipt.resource_id,
      v_receipt.resource_version,
      v_receipt.resource_deleted_at,
      true;
    RETURN;
  END IF;

  SELECT record.*
  INTO v_record
  FROM public.create_record_command_v1(
    v_user_id,
    p_title,
    p_note,
    p_plan_id,
    NULL::UUID,
    'api'::TEXT,
    p_start_at,
    p_end_at,
    p_activity_id,
    p_fulfillment
  ) AS record;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record command returned no row'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'MCP mutation result invariant failed'
      USING ERRCODE = 'DM007';
  END IF;

  -- Record create may wait on a linked Plan row and the Record exclusion
  -- constraint. Expiry after either wait rolls back the row and receipt.
  IF v_authority_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  INSERT INTO public.mcp_mutation_receipts (
    user_id,
    client_id,
    operation_id,
    origin_connection_id,
    envelope_version,
    tool_name,
    request_digest,
    resource_type,
    resource_id,
    resource_version,
    resource_deleted_at
  ) VALUES (
    v_user_id,
    v_client_id,
    p_operation_id,
    p_connection_id,
    1,
    'records.create',
    v_request_digest,
    'record',
    v_record.id,
    v_record.updated_at,
    v_record.deleted_at
  )
  RETURNING * INTO v_receipt;

  RETURN QUERY SELECT
    v_receipt.envelope_version,
    v_receipt.operation_id,
    v_receipt.resource_type,
    v_receipt.resource_id,
    v_receipt.resource_version,
    v_receipt.resource_deleted_at,
    false;
END;
$function$;

CREATE OR REPLACE FUNCTION private.set_plan_skipped_unserialized_v1(p_user_id uuid, p_plan_id uuid, p_expected_updated_at timestamp with time zone, p_skipped boolean)
 RETURNS SETOF plans
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Manual skip has been removed; refresh the client' USING ERRCODE = 'DT012';
END;
$function$;

CREATE OR REPLACE FUNCTION private.undo_full_mask_v1(p_resource_type text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- insert effect（undo=DELETE）は行全体を消す操作のため、field maskは
  -- その resource_type が持つ allowlist 対象列を漏れなく含まなければならない。
  -- 1列でも漏れると、その列への正当な事後編集がDELETEに巻き込まれ silent に消える。
  SELECT CASE p_resource_type
    WHEN 'plan' THEN ARRAY['deleted_at', 'end_at', 'note', 'start_at', 'title']
    WHEN 'record' THEN ARRAY['deleted_at', 'end_at', 'note', 'start_at', 'title']
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION private.undo_field_applicable_v1(p_field_name text, p_resource_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- skipped_at は plans にしか存在しない列（records には無い）。
  -- それ以外のallowlist列（title/note/start_at/end_at/deleted_at）は両resourceに存在する。
  SELECT CASE
    WHEN p_field_name = 'skipped_at' THEN FALSE
    ELSE TRUE
  END;
$function$;

CREATE OR REPLACE FUNCTION private.apply_undo_receipt_v1(p_user_id uuid, p_receipt_id uuid, p_apply_operation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_receipt public.undo_receipts%ROWTYPE;
  v_current_effect_count SMALLINT;
  v_connection RECORD;
  v_effective_scopes TEXT[];
  v_effect RECORD;
  v_required_scope TEXT;
  v_set_clauses TEXT[];
  v_where_clauses TEXT[];
  v_field RECORD;
  v_field_type TEXT;
  v_field_sql TEXT;
  v_table_name TEXT;
  v_resource_id UUID;
  v_row_count INTEGER;
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();

  IF p_user_id IS NULL OR p_receipt_id IS NULL OR p_apply_operation_id IS NULL THEN
    RAISE EXCEPTION 'apply_undo_receipt_v1 requires user_id, receipt_id, apply_operation_id'
      USING ERRCODE = '22004';
  END IF;

  PERFORM private.lock_timeblock_user_write_shared_v1(p_user_id);

  -- receipt自体をロックする（同一receiptへの同時apply/二重undoを防ぐ）。
  SELECT * INTO v_receipt
  FROM public.undo_receipts
  WHERE id = p_receipt_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'undo receipt % not found' , p_receipt_id
      USING ERRCODE = 'DR001';
  END IF;

  IF v_receipt.undone_at IS NOT NULL THEN
    IF v_receipt.undone_operation_id = p_apply_operation_id THEN
      -- 同一apply操作の再送。冪等に成功を返す。
      RETURN;
    END IF;
    RAISE EXCEPTION 'undo receipt % was already undone' , p_receipt_id
      USING ERRCODE = 'DR002';
  END IF;

  IF v_receipt.undo_expires_at <= now() THEN
    RAISE EXCEPTION 'undo receipt % has expired', p_receipt_id
      USING ERRCODE = 'DR003';
  END IF;

  -- 欠損検査: 記録時のeffect数と現在のeffect数を再照合する。
  -- CASCADEによる部分/全部欠損（単発の物理削除・account purge後のtombstone）を
  -- silent no-op / silent partial applyにしない。
  SELECT count(*) INTO v_current_effect_count
  FROM public.undo_receipt_effects
  WHERE receipt_id = p_receipt_id;

  IF v_current_effect_count <> v_receipt.recorded_effect_count THEN
    RAISE EXCEPTION 'undo receipt % effect count mismatch (recorded %, current %); resource(s) were removed by another path',
      p_receipt_id, v_receipt.recorded_effect_count, v_current_effect_count
      USING ERRCODE = 'DR004';
  END IF;

  -- 権限交差判定（UI由来はスキップ、origin_connection由来は現在scopes ∩ snapshot）。
  IF v_receipt.had_origin_connection THEN
    IF v_receipt.origin_connection_id IS NULL THEN
      -- connectionが物理削除された（retention cleanup）。revoke相当として拒否する。
      RAISE EXCEPTION 'undo receipt % origin connection no longer exists (treated as revoked)',
        p_receipt_id
        USING ERRCODE = 'DR005';
    END IF;

    -- FOR UPDATEでconnection行をロックし、権限判定と同時進行のrevokeのTOCTOUを防ぐ。
    SELECT connection.revoked_at, connection.reauth_required_at, connection.scopes
    INTO v_connection
    FROM public.oauth_connections AS connection
    WHERE connection.id = v_receipt.origin_connection_id AND connection.user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'undo receipt % origin connection not found', p_receipt_id
        USING ERRCODE = 'DR005';
    END IF;
    IF v_connection.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'undo receipt % origin connection is revoked', p_receipt_id
        USING ERRCODE = 'DR006';
    END IF;
    IF v_connection.reauth_required_at <= now() THEN
      RAISE EXCEPTION 'undo receipt % origin connection requires reauth', p_receipt_id
        USING ERRCODE = 'DR007';
    END IF;

    SELECT ARRAY(
      SELECT unnest(v_connection.scopes)
      INTERSECT
      SELECT unnest(v_receipt.origin_scopes_snapshot)
    ) INTO v_effective_scopes;
  END IF;

  -- 対象resourceを正準順（resource_type, resource_id昇順）で処理し、
  -- 複数effectをまたぐFOR UPDATEのロック順序をUndo呼び出し間で一貫させる
  -- （デッドロック防止）。
  IF EXISTS (
    SELECT 1 FROM public.undo_receipt_field_changes AS change
    JOIN public.undo_receipt_effects AS effect ON effect.id = change.effect_id
    WHERE effect.receipt_id = p_receipt_id AND change.field_name = 'skipped_at'
  ) THEN
    RAISE EXCEPTION 'This receipt contains a retired skip change and cannot be undone' USING ERRCODE = 'DR008';
  END IF;

  FOR v_effect IN
    SELECT effect.id, effect.plan_id, effect.record_id, effect.resource_type, effect.effect_kind
    FROM public.undo_receipt_effects AS effect
    WHERE effect.receipt_id = p_receipt_id
    ORDER BY effect.resource_type, COALESCE(effect.plan_id, effect.record_id)
  LOOP
    IF v_effect.effect_kind = 'delete' THEN
      RAISE EXCEPTION 'undo receipt % contains an unsupported delete effect', p_receipt_id
        USING ERRCODE = 'DR008';
    END IF;

    IF v_receipt.had_origin_connection THEN
      v_required_scope := private.undo_required_scope_v1(v_effect.resource_type, v_effect.effect_kind);
      IF v_required_scope IS NULL OR NOT (v_required_scope = ANY(v_effective_scopes)) THEN
        RAISE EXCEPTION 'undo receipt % lacks required scope % for % effect on %',
          p_receipt_id, v_required_scope, v_effect.effect_kind, v_effect.resource_type
          USING ERRCODE = 'DR009';
      END IF;
    END IF;

    v_table_name := v_effect.resource_type || 's'; -- 'plan' -> 'plans', 'record' -> 'records'
    v_resource_id := COALESCE(v_effect.plan_id, v_effect.record_id);
    v_set_clauses := ARRAY[]::TEXT[];
    v_where_clauses := ARRAY[]::TEXT[];

    FOR v_field IN
      SELECT field_name, before_value, after_value
      FROM public.undo_receipt_field_changes
      WHERE effect_id = v_effect.id
      ORDER BY field_name
    LOOP
      v_field_type := private.undo_field_sql_type_v1(v_field.field_name);
      IF v_field_type IS NULL THEN
        RAISE EXCEPTION 'internal error: field % has no known SQL type', v_field.field_name
          USING ERRCODE = 'XX000';
      END IF;

      -- CAS: 現在値 == after_value（mask内フィールドが元操作後に変更されていないか）。
      v_where_clauses := array_append(
        v_where_clauses,
        format('%I IS NOT DISTINCT FROM %L::%s', v_field.field_name, v_field.after_value #>> '{}', v_field_type)
      );

      IF v_effect.effect_kind = 'update' THEN
        -- 復元先はbefore_value。
        v_field_sql := format('%I = %L::%s', v_field.field_name, v_field.before_value #>> '{}', v_field_type);
        v_set_clauses := array_append(v_set_clauses, v_field_sql);
      END IF;
    END LOOP;

    IF v_effect.effect_kind = 'update' THEN
      EXECUTE format(
        'UPDATE public.%I SET %s WHERE id = %L AND user_id = %L AND %s',
        v_table_name,
        array_to_string(v_set_clauses, ', '),
        v_resource_id,
        p_user_id,
        array_to_string(v_where_clauses, ' AND ')
      );
    ELSE
      -- insert effect の undo = 対象行のDELETE。
      EXECUTE format(
        'DELETE FROM public.%I WHERE id = %L AND user_id = %L AND %s',
        v_table_name,
        v_resource_id,
        p_user_id,
        array_to_string(v_where_clauses, ' AND ')
      );
    END IF;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count <> 1 THEN
      RAISE EXCEPTION 'undo receipt % CAS failed for % % (masked fields changed since original operation, or resource missing)',
        p_receipt_id, v_effect.resource_type, v_resource_id
        USING ERRCODE = 'DR010';
    END IF;
  END LOOP;

  UPDATE public.undo_receipts
  SET undone_at = now(), undone_operation_id = p_apply_operation_id
  WHERE id = p_receipt_id;
END;
$function$;

CREATE OR REPLACE FUNCTION private.undo_field_sql_type_v1(p_field_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_field_name
    WHEN 'title' THEN 'text'
    WHEN 'note' THEN 'text'
    WHEN 'start_at' THEN 'timestamptz'
    WHEN 'end_at' THEN 'timestamptz'
    WHEN 'deleted_at' THEN 'timestamptz'
    ELSE NULL
  END;
$function$;

COMMIT;
