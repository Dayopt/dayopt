-- Contract stage: remove persisted Plan/Record relation and skipped state.
-- Phase 1 already removed every runtime reader, writer dependency, FK, index and trigger.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.plans, public.records IN ACCESS EXCLUSIVE MODE;

-- Keep the legacy RPC signature during the final client drain, but fail explicitly.
CREATE OR REPLACE FUNCTION private.set_plan_skipped_unserialized_v1(
  p_user_id uuid,
  p_plan_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_skipped boolean
)
 RETURNS SETOF plans
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Skipped state has been removed; refresh the client'
    USING ERRCODE = 'DT012';
END;
$function$;

CREATE OR REPLACE FUNCTION private.undo_full_mask_v1(p_resource_type text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_resource_type
    WHEN 'plan' THEN ARRAY['deleted_at', 'end_at', 'note', 'start_at', 'title']
    WHEN 'record' THEN ARRAY['deleted_at', 'end_at', 'note', 'start_at', 'title']
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION private.undo_field_applicable_v1(
  p_field_name text,
  p_resource_type text
)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_field_name <> 'skipped_at';
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
    WHERE effect.receipt_id = p_receipt_id
      AND effect.effect_kind = 'update'
      AND change.field_name = 'skipped_at'
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
      -- Contract後も、列撤去前に発行済みの通常Plan作成receiptは適用できる。
      -- skipped_atはもう保存状態ではないため、insert effectのCAS対象からだけ外す。
      IF v_field.field_name = 'skipped_at' THEN
        IF v_effect.resource_type = 'plan' AND v_effect.effect_kind = 'insert' THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'This receipt contains a retired skip change and cannot be undone'
          USING ERRCODE = 'DR008';
      END IF;

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


ALTER TABLE public.records DROP COLUMN plan_id;
ALTER TABLE public.plans DROP COLUMN skipped_at;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid IN ('public.plans'::regclass, 'public.records'::regclass)
      AND attname IN ('skipped_at', 'plan_id')
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'legacy Plan/Record columns remain after contraction';
  END IF;
END;
$verify$;

COMMENT ON FUNCTION private.set_plan_skipped_unserialized_v1(
  uuid, uuid, timestamp with time zone, boolean
) IS 'Contract compatibility stub. Skip state is no longer persisted; all calls fail with DT012.';

COMMENT ON FUNCTION private.undo_full_mask_v1(text) IS
  'insert effectのUndo用full mask。Plan/Recordの現行保存列だけを列挙する。';

COMMENT ON FUNCTION private.undo_field_applicable_v1(text, text) IS
  '現行保存列だけをUndo対象として受理する。撤去済みskipped_atは新規receiptで拒否する。';

COMMENT ON FUNCTION private.apply_undo_receipt_v1(uuid, uuid, uuid) IS
  'Undo receiptをCAS適用する。旧skip更新はDR008で拒否し、列撤去前の通常Plan作成receiptはskipped_atを無視して互換適用する。';

COMMIT;
