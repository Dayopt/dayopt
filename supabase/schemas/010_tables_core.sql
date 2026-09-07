-- ============================================================
-- コアテーブル（読み物用 — CLIでは使用しない）
-- ============================================================
-- Dayopt のドメインモデルの中核テーブル
-- 実際のマイグレーションは migrations/ を参照
-- 最終同期日: 2026-09-04
-- 同期対象 migration:
--   - 20260415000000_inline_entry_tag_id.sql
--   - 20260424000000_restore_tag_parent_hierarchy.sql
--   - 20260425110000_fix_tag_children_trigger_active_only.sql
--   - 20260610000000_entry_auto_record_model.sql
--   - 20260616000000_rename_duration_to_planned_duration.sql
--   - 20260708232500_add_time_model_tables.sql
--   - 20260712212527_records_table_and_drop_entries.sql
--   - 20260712213550_rename_record_constraint_triggers.sql
--   - 20260723233814_add_calendar_connection_tables.sql
--   - 20260724000416_enforce_external_event_connection_owner.sql
--   - 20260729062435_timeblock_atomic_commands.sql
--   - 20260729062437_timeblock_command_hardening.sql
--   - 20260729062439_timeblock_confirm_day_command.sql
--   - 20260729062441_timeblock_confirm_day_serialization.sql
--   - 20260729062443_timeblock_confirm_day_range_limit.sql
--   - 20260729062458_recordable_plan_error_contract.sql
--   - 20260729062500_recordable_plan_trigger_error_contract.sql
--   - 20260729073122_mcp_stage1_user_write_serialization.sql
--   - 20260729073123_mcp_stage1_legacy_writer_compatibility.sql
--   - 20260729073124_mcp_stage1_revision_fence.sql
--   - 20260729073127_legacy_linked_record_restore_compatibility.sql
--   - 20260824090000_detach_tag_id_from_timeblock_write_path.sql
--   - 20260826234713_add_ledger_composite_tenant_anchors.sql
--   - 20260826234911_add_ledger_undo_substrate.sql
--   - 20260903120000_drop_legacy_tags_model.sql
--
-- カラム順序の規則:
--   1. id (PK)
--   2. user_id (FK/所有者)
--   3. 外部キー
--   4. ビジネスカラム
--   5. ステータス/フラグ
--   6. メタ (created_at, updated_at, deleted_at)
-- ============================================================

-- profiles: ユーザープロフィール
-- auth.users 作成時に handle_new_user() トリガーで自動生成
-- id = auth.users.id（1:1対応）
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,                 -- 表示名
  avatar_url TEXT,
  stripe_customer_id TEXT,       -- Stripe顧客ID
  subscription_id TEXT,          -- Stripeサブスクリプション ID
  subscription_status TEXT NOT NULL DEFAULT 'free', -- free / trialing / active / canceled / past_due
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- calendar_connections: 外部カレンダーのアカウント接続（Phase 2 / external-calendar-import）
-- 同一 provider の複数アカウントを許容する（UNIQUE は user_id + provider + provider_account_id）
-- access token は保存しない。refresh_token_enc は AES-256-GCM 暗号文
-- refresh_token_enc / granted_scopes / provider_account_id は authenticated へ grant しない
-- （column-scoped SELECT。詳細は rls-snapshot.md）
CREATE TABLE public.calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                 -- google 等。free text + not-blank（enum 不使用）
  provider_account_id TEXT NOT NULL,      -- Google の sub
  provider_account_email TEXT,
  granted_scopes TEXT[] NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  refresh_token_rotation_operation_id UUID,
  data_generation BIGINT NOT NULL DEFAULT 0,
  authority_fence_id UUID,
  authority_epoch BIGINT,
  sync_sequence BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                   -- active / reauth_required
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- calendar_connections 関連 constraint / trigger:
--   calendar_connections_status_check             -> status IN ('active','reauth_required')
--   calendar_connections_granted_scopes_not_empty -> cardinality > 0 かつ NULL 要素なし
--   calendar_connections_id_user_id_unique        -> 子テーブルの複合 FK 参照先
--   calendar_connections_provider_account_unique  -> user_id + provider + provider_account_id
--   data_generation -> 接続保存時のuser data purge世代。古いcallback/syncの再作成を拒否する
--   authority_fence_id / authority_epoch
--     -> Google Cloud project + provider_account_id単位のrevoke authority世代
--   sync_sequence -> DB発行の単調増加writer世代。古いsync runの更新を拒否する
--   refresh_token_rotation_operation_id -> response欠落時のrotation再試行identity
--   trigger_update_calendar_connections_updated_at -> update_updated_at()

-- calendar_connection_calendars: 取り込み対象として選択されたカレンダー
-- 選択可能な一覧は provider API からオンデマンド取得し保存しない
-- sync_token は per-calendar cursor（NULL = 次回 full sync）
CREATE TABLE public.calendar_connection_calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_calendar_id TEXT NOT NULL,
  calendar_name TEXT,
  sync_token TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- calendar_connection_calendars 関連 constraint / trigger:
--   calendar_connection_calendars_connection_owner_fkey
--     -> (connection_id, user_id) が calendar_connections(id, user_id) を参照（ON DELETE CASCADE）
--        owner 整合は constraint trigger ではなくこの複合 FK で担保する
--   calendar_connection_calendars_provider_calendar_unique -> connection_id + provider_calendar_id
--   trigger_update_calendar_connection_calendars_updated_at -> update_updated_at()

-- external_calendar_events: 外部カレンダー同期ミラー
-- Phase 1 では FK の受け皿だけを追加し、OAuth / sync / ghost UI は Phase 2 で実装する
-- connection_id は Phase 2 で追加。切断後も plans / records が参照する行は履歴の
-- アンカーとして残るため CASCADE にしない
CREATE TABLE public.external_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID,
  provider TEXT NOT NULL,
  provider_calendar_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  calendar_name TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- external_calendar_events 関連 constraint / index:
--   external_calendar_events_provider_event_unique
--     -> user_id + provider + connection_id + provider_calendar_id + provider_event_id
--        connection_id を含むのは、同一 provider の複数アカウントが同じ共有カレンダーを
--        購読しても行が衝突しないようにするため
--   external_calendar_events_connection_owner_fkey
--     -> (connection_id, user_id) が calendar_connections(id, user_id) を参照。
--        ON DELETE SET NULL (connection_id) — 列リスト指定が必須（bare SET NULL だと
--        NOT NULL の user_id まで NULL 化しようとして 23502 になる）。
--        MATCH SIMPLE なので connection_id が NULL の孤立行は検査対象外

-- plans: Dayopt 内の予定
CREATE TABLE public.plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  external_calendar_event_id UUID REFERENCES public.external_calendar_events(id),
  title TEXT NOT NULL,
  note TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  skipped_at TIMESTAMPTZ, -- 段階移行中の互換列。依存撤去後の別migrationで削除する
  source TEXT NOT NULL DEFAULT 'manual', -- manual / external_calendar / api
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- plans 関連 constraint / trigger:
--   plans_no_overlap                    -> user_id + tstzrange(start_at, end_at, '[)') EXCLUDE
--   prevent_plans_source_change         -> prevent_time_model_source_change()
--   enforce_plan_external_event_owner   -> enforce_plan_external_event_owner()
--   validate_plan_temporal_write_v1      -> 時刻順序のみ。Plan は時間軸のどこにでも置ける
--   enforce_plan_skip_record_invariant_v1
--     -> active Record がある Plan の skip を拒否
--   direct DML / command writer fence
--     -> 旧UIのdirect DMLとtyped commandをglobal + user単位lockで直列化し、
--        commit時のuser revisionをtransactionごとに1回だけ進める

-- records: Dayopt 内の記録
CREATE TABLE public.records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id UUID, -- 段階移行中の互換列。FKなし。別migrationで削除する
  external_calendar_event_id UUID REFERENCES public.external_calendar_events(id),
  title TEXT NOT NULL,
  note TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- manual / from_plan / auto_migrated / external_calendar / api
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- records 関連 constraint / trigger:
--   records_no_overlap                    -> user_id + tstzrange(start_at, end_at, '[)') EXCLUDE
--   prevent_records_source_change         -> prevent_time_model_source_change()
--   enforce_record_external_event_owner   -> enforce_record_external_event_owner()
--   validate_record_temporal_write_v1      -> 時刻順序、未来 Record を拒否
--   enforce_active_record_plan_v1
--     -> new link/relinkはactive / owner / non-skipped Planだけ。
--        既存リンクを持つRecordのrestoreだけはPlan soft-delete後も現行UI互換で許可
--   direct DML / command writer fence
--     -> Planと同じuser binding、lock upgrade拒否、transaction単位revisionを適用

-- tags: 削除済み（20260903120000_drop_legacy_tags_model.sql、#2175）
--   plans.tag_id / records.tag_id と tags 専有 10 関数も同 migration で drop

-- entries / entry_tags: 削除済み
--   20260415000000_inline_entry_tag_id.sql
--   20260712212527_records_table_and_drop_entries.sql

-- entry_instances: 削除済み（20260319130003_cleanup_recurrence_remnants.sql）

-- user_settings: ユーザー設定（1ユーザー1レコード）
CREATE TABLE public.user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 時間
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  time_format TEXT NOT NULL DEFAULT '24h',      -- 24h / 12h
  week_starts_on SMALLINT NOT NULL DEFAULT 1,   -- 0=Sun, 1=Mon, 6=Sat
  default_duration INTEGER NOT NULL DEFAULT 60,
  -- 表示
  show_weekends BOOLEAN NOT NULL DEFAULT true,
  show_week_numbers BOOLEAN NOT NULL DEFAULT false,
  default_view TEXT NOT NULL DEFAULT 'week',
  hour_height_density TEXT NOT NULL DEFAULT 'default', -- compact / default / comfortable
  -- ロケール
  preferred_locale TEXT NOT NULL DEFAULT 'en',   -- en / ja
  -- テーマ
  theme TEXT NOT NULL DEFAULT 'system',
  -- パーソナライゼーション（将来のAI機能用、構造未定）
  personalization JSONB,
  -- iCalフィード
  ical_feed_token UUID DEFAULT gen_random_uuid(), -- iCal連携用トークン
  -- メタ
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Undo substrate（#2433、台帳 第2段）
-- ============================================================
-- 凍結契約 T4 の「複数 resource × フィールド単位の before/after image」を 3 階層へ
-- 正規化したもの。**構造だけが第2段の scope で、Undo RPC 本体は第3段**。
--
-- 設計上の要点（migration のコメントが正本、ここは要約）:
-- ■ 行単位の版列を持たない。T4 訂正（#2443）で CAS の判定対象が field mask 内へ
--   限定されたため、CAS anchor は field_changes.after_value が兼ねる。版列を置くと
--   実装が行単位 CAS へ引き戻され、T4 の矛盾が schema の形で復活する
-- ■ resource は polymorphic な単一 ID にしない。plan_id / record_id へ分けることで
--   (resource_id, user_id) の複合 FK を実際に張れる（他人の resource を混ぜられない）
-- ■ authenticated への GRANT は本段では出さない。policy だけ先に確定させ、読みの開放は
--   第3段で GRANT 1 行を足す（public schema は PostgREST が自動公開するため、読み手が
--   無いうちに列の形を公開契約として確定させない）

CREATE TABLE public.undo_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,               -- T3 の domain command 冪等性キー
  command_name TEXT NOT NULL,
  origin_connection_id UUID,                -- 元操作の authority の出所（UI 由来なら NULL）
  undo_expires_at TIMESTAMPTZ NOT NULL,     -- **DEFAULT なし**（TTL の具体値は第3段）
  undone_at TIMESTAMPTZ,
  undone_operation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT undo_receipts_id_user_id_unique UNIQUE (id, user_id),
  CONSTRAINT undo_receipts_user_id_operation_id_unique UNIQUE (user_id, operation_id),
  CONSTRAINT undo_receipts_command_name_not_blank CHECK (length(btrim(command_name)) > 0),
  CONSTRAINT undo_receipts_undone_pair
    CHECK ((undone_at IS NULL) = (undone_operation_id IS NULL)),
  -- 単一 FK にしない。connection 削除時は列指定 SET NULL で user_id を巻き込まない
  CONSTRAINT undo_receipts_origin_connection_owner_fkey
    FOREIGN KEY (origin_connection_id, user_id)
    REFERENCES public.oauth_connections (id, user_id)
    ON DELETE SET NULL (origin_connection_id)
);

CREATE TABLE public.undo_receipt_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receipt_id UUID NOT NULL,
  plan_id UUID,                             -- plan_id / record_id はどちらか一方だけ
  record_id UUID,
  resource_type TEXT GENERATED ALWAYS AS (
    CASE WHEN plan_id IS NOT NULL THEN 'plan' ELSE 'record' END
  ) STORED,
  effect_kind TEXT NOT NULL,                -- insert / update / delete
  CONSTRAINT undo_receipt_effects_id_user_id_unique UNIQUE (id, user_id),
  CONSTRAINT undo_receipt_effects_exactly_one_resource
    CHECK (num_nonnulls(plan_id, record_id) = 1),
  CONSTRAINT undo_receipt_effects_effect_kind_valid
    CHECK (effect_kind IN ('insert', 'update', 'delete')),
  CONSTRAINT undo_receipt_effects_receipt_owner_fkey
    FOREIGN KEY (receipt_id, user_id)
    REFERENCES public.undo_receipts (id, user_id) ON DELETE CASCADE,
  CONSTRAINT undo_receipt_effects_plan_owner_fkey
    FOREIGN KEY (plan_id, user_id)
    REFERENCES public.plans (id, user_id) ON DELETE CASCADE,
  CONSTRAINT undo_receipt_effects_record_owner_fkey
    FOREIGN KEY (record_id, user_id)
    REFERENCES public.records (id, user_id) ON DELETE CASCADE,
  CONSTRAINT undo_receipt_effects_receipt_plan_unique UNIQUE (receipt_id, plan_id),
  CONSTRAINT undo_receipt_effects_receipt_record_unique UNIQUE (receipt_id, record_id)
);

CREATE TABLE public.undo_receipt_field_changes (
  effect_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  -- SQL の NULL は JSON の null で表す（「触れていない」と「値が NULL」を区別する）
  before_value JSONB NOT NULL,
  after_value JSONB NOT NULL,               -- T4 訂正 (a) の CAS anchor はこれ
  CONSTRAINT undo_receipt_field_changes_pkey PRIMARY KEY (effect_id, field_name),
  CONSTRAINT undo_receipt_field_changes_field_name_not_blank
    CHECK (length(btrim(field_name)) > 0),
  CONSTRAINT undo_receipt_field_changes_effect_owner_fkey
    FOREIGN KEY (effect_id, user_id)
    REFERENCES public.undo_receipt_effects (id, user_id) ON DELETE CASCADE
);

-- 複合 tenant FK の anchor（#2433）。子が (親の id, user_id) で参照するために要る。
-- ALTER TABLE public.plans             ADD CONSTRAINT plans_id_user_id_unique UNIQUE (id, user_id);
-- ALTER TABLE public.records           ADD CONSTRAINT records_id_user_id_unique UNIQUE (id, user_id);
-- ALTER TABLE public.oauth_connections ADD CONSTRAINT oauth_connections_id_user_id_unique UNIQUE (id, user_id);
