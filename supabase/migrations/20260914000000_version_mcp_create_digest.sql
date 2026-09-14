-- #2736: 内部 digest 形式を識別する。公開 envelope_version は変更しない。
-- 既存 digest / applied_at は更新しない。DEFAULT 1 は旧コードの INSERT も識別する。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.mcp_mutation_receipts
  ADD COLUMN digest_version SMALLINT NOT NULL DEFAULT 1
  CONSTRAINT mcp_mutation_receipts_digest_version_check CHECK (digest_version IN (1, 2));
COMMENT ON COLUMN public.mcp_mutation_receipts.digest_version IS
  'Internal format: 1 legacy; 2 create payload without tagId. Independent of public receipt schema version. Existing receipts remain immutable.';

-- 呼び出し元は認可と同一 operation の lock を取得済み。
-- 保持期限・削除済みデータ・envelope 検証は既存 resolver に委ねる。
CREATE FUNCTION private.resolve_mcp_create_replay_v2(
  p_user_id UUID, p_client_id TEXT, p_operation_id UUID, p_tool_name TEXT,
  p_request_digest BYTEA, p_legacy_digest BYTEA, p_resource_type TEXT
)
RETURNS SETOF public.mcp_mutation_receipts
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_digest_version SMALLINT;
BEGIN
  SELECT receipt.digest_version INTO v_digest_version
  FROM public.mcp_mutation_receipts AS receipt
  WHERE receipt.user_id = p_user_id AND receipt.client_id = p_client_id
    AND receipt.operation_id = p_operation_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_digest_version NOT IN (1, 2) THEN
    RAISE EXCEPTION 'Unknown MCP digest format' USING ERRCODE = 'DM007';
  END IF;
  RETURN QUERY SELECT replay.* FROM private.resolve_mcp_mutation_replay_v1(
    p_user_id, p_client_id, p_operation_id, p_tool_name,
    CASE WHEN v_digest_version = 1 THEN p_legacy_digest ELSE p_request_digest END,
    1::SMALLINT, p_resource_type
  ) AS replay;
END;
$$;
REVOKE ALL ON FUNCTION private.resolve_mcp_create_replay_v2(UUID, TEXT, UUID, TEXT, BYTEA, BYTEA, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.enforce_mcp_mutation_receipt_lifecycle_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_generation BIGINT;
  v_origin_detach_allowed BOOLEAN;
  v_purge_mark_allowed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_generation := private.get_user_data_generation_v1(NEW.user_id);
    NEW.data_generation := v_generation;
    NEW.purged_generation := NULL;
    NEW.purged_at := NULL;
    NEW.applied_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;

  v_origin_detach_allowed := (
    NEW.origin_connection_id IS NOT DISTINCT FROM OLD.origin_connection_id
    OR (
      OLD.origin_connection_id IS NOT NULL
      AND NEW.origin_connection_id IS NULL
    )
  );

  v_purge_mark_allowed := (
    (
      NEW.purged_generation IS NOT DISTINCT FROM OLD.purged_generation
      AND NEW.purged_at IS NOT DISTINCT FROM OLD.purged_at
      AND NEW.resource_deleted_at IS NOT DISTINCT FROM OLD.resource_deleted_at
    )
    OR (
      OLD.purged_generation IS NULL
      AND OLD.purged_at IS NULL
      AND NEW.purged_generation IS NOT NULL
      AND NEW.purged_at IS NOT NULL
      AND NEW.purged_generation > OLD.data_generation
      AND NEW.resource_deleted_at IS NOT NULL
      AND (
        OLD.resource_deleted_at IS NULL
        OR NEW.resource_deleted_at IS NOT DISTINCT FROM OLD.resource_deleted_at
      )
    )
  );

  IF v_origin_detach_allowed
    AND v_purge_mark_allowed
    AND ROW(
      NEW.user_id,
      NEW.client_id,
      NEW.operation_id,
      NEW.envelope_version,
      NEW.tool_name,
      NEW.request_digest,
      NEW.digest_version,
      NEW.resource_type,
      NEW.resource_id,
      NEW.resource_version,
      NEW.applied_at,
      NEW.data_generation
    ) IS NOT DISTINCT FROM ROW(
      OLD.user_id,
      OLD.client_id,
      OLD.operation_id,
      OLD.envelope_version,
      OLD.tool_name,
      OLD.request_digest,
      OLD.digest_version,
      OLD.resource_type,
      OLD.resource_id,
      OLD.resource_version,
      OLD.applied_at,
      OLD.data_generation
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'MCP mutation receipts are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_mcp_plan_create_v1(p_connection_id uuid, p_access_token_id uuid, p_operation_id uuid, p_title text, p_note text, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_activity_id uuid DEFAULT NULL::uuid)
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
  v_decision_at TIMESTAMPTZ;
  v_request_digest BYTEA;
  v_legacy_digest BYTEA;
  v_payload JSONB;
  v_receipt public.mcp_mutation_receipts%ROWTYPE;
  v_plan public.plans%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_connection_id IS NULL
    OR p_access_token_id IS NULL
    OR p_operation_id IS NULL
    OR p_start_at IS NULL
    OR p_end_at IS NULL THEN
    RAISE EXCEPTION 'MCP Plan create input is incomplete'
      USING ERRCODE = '22004';
  END IF;

  IF NOT pg_catalog.isfinite(p_start_at) OR NOT pg_catalog.isfinite(p_end_at) THEN
    RAISE EXCEPTION 'MCP Plan timestamps must be finite'
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
    'write:plans'::TEXT,
    p_operation_id
  ) AS auth_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  -- 新規発行は形式 2。旧形式の再送照合だけ固定キーを復元する。
  v_payload := pg_catalog.jsonb_build_object(
      'title', p_title,
      'note', p_note,
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
       END;
  v_request_digest := private.digest_mcp_mutation_envelope_v1('plans.create', v_payload);
  v_legacy_digest := private.digest_mcp_mutation_envelope_v1(
    'plans.create', v_payload || pg_catalog.jsonb_build_object('tagId', NULL::UUID)
  );

  SELECT replay_receipt.*
  INTO v_receipt
  FROM private.resolve_mcp_create_replay_v2(
    v_user_id,
    v_client_id,
    p_operation_id,
    'plans.create'::TEXT,
    v_request_digest,
    v_legacy_digest,
    'plan'::TEXT
  ) AS replay_receipt;

  v_decision_at := pg_catalog.clock_timestamp();
  IF v_authority_expires_at <= v_decision_at THEN
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

  SELECT plan.*
  INTO v_plan
  FROM public.create_plan_command_v1(
    v_user_id,
    p_title,
    p_note,
    NULL::UUID,
    'api'::TEXT,
    p_start_at,
    p_end_at,
    p_activity_id
  ) AS plan;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan command returned no row'
      USING ERRCODE = 'P0002';
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
    digest_version,
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
    'plans.create',
    v_request_digest,
    2,
    'plan',
    v_plan.id,
    v_plan.updated_at,
    v_plan.deleted_at
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
$function$
;

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
  v_legacy_digest BYTEA;
  v_payload JSONB;
  v_receipt public.mcp_mutation_receipts%ROWTYPE;
  v_record public.records%ROWTYPE;
BEGIN
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

  -- 新規発行は形式 2。旧形式の再送照合だけ固定キーを復元する。
  v_payload := pg_catalog.jsonb_build_object(
      'title', p_title,
      'note', p_note,
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
       END;
  v_request_digest := private.digest_mcp_mutation_envelope_v1('records.create', v_payload);
  v_legacy_digest := private.digest_mcp_mutation_envelope_v1(
    'records.create', v_payload || pg_catalog.jsonb_build_object('tagId', NULL::UUID)
  );

  SELECT replay_receipt.*
  INTO v_receipt
  FROM private.resolve_mcp_create_replay_v2(
    v_user_id,
    v_client_id,
    p_operation_id,
    'records.create'::TEXT,
    v_request_digest,
    v_legacy_digest,
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

  -- 旧形式で完了済みのmutationは上で再生する。receiptが無い新規リンク要求だけ拒否する。
  IF p_plan_id IS NOT NULL THEN
    RAISE EXCEPTION 'Plan links have been removed; omit planId and refresh the tool schema' USING ERRCODE = 'DT012';
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
    digest_version,
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
    2,
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

COMMIT;
