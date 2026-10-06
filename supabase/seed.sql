-- ============================================================
-- Dayopt local / PR Preview 用シードデータ
-- ============================================================
-- `supabase db reset` や Supabase Branch deployment 時に読み込まれる。
-- production data はコピーせず、PR 検証に必要な最小データだけを作る。
--
-- テストユーザー + 2週間分のサンプルデータ → 統計・振り返り機能が即テスト可能
-- app-only PR の command 検証もこの決定的なユーザーを使い、追加の Auth user は作らない。
-- ============================================================

-- NOTE: MCP environment identity はこの seed では入れない。seed.sql は
-- Supabase Preview Branch でも実行され、Preview の identity は
-- provision_mcp_preview_environment_identity_v1 が後から bind する契約の
-- ため。ローカル開発用の identity 投入は supabase/local/mcp-identity-seed.sql
-- を `pnpm db:fresh`（または `pnpm db:seed:identity`）が 127.0.0.1 固定で
-- 適用する。

-- ============================================================
-- テストユーザー
-- ============================================================

-- テストユーザーをauth.usersに作成（ローカルInbucket用）
-- パスワード: TestPassword123!
INSERT INTO auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  role,
  aud,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  email_change_token_current,
  phone,
  phone_change,
  phone_change_token,
  reauthentication_token,
  email_change_confirm_status
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'test-seed@dayopt.dev',
  crypt('TestPassword123!', gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Test User"}',
  now(),
  now(),
  'authenticated',
  'authenticated',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  0
)
ON CONFLICT DO NOTHING;

-- identityも作成（ログインに必要）
INSERT INTO auth.identities (
  id,
  user_id,
  provider_id,
  provider,
  identity_data,
  last_sign_in_at,
  created_at,
  updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'test-seed@dayopt.dev',
  'email',
  '{"sub": "00000000-0000-0000-0000-000000000001", "email": "test-seed@dayopt.dev"}',
  now(),
  now(),
  now()
)
ON CONFLICT DO NOTHING;

-- NOTE: profiles は auth.users INSERT 時に handle_new_user() トリガーで自動作成

-- ============================================================
-- ユーザー設定
-- ============================================================

INSERT INTO public.user_settings (user_id, timezone, time_format, week_starts_on, default_duration)
VALUES ('00000000-0000-0000-0000-000000000001', 'Asia/Tokyo', '24h', 1, 60)
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- カテゴリー / アクティビティ（3構造モデル。#2162 で tags を置き換えたもの）
-- ============================================================
-- 旧 seed は tags だけを作っており activities / categories が 0 行だったため、
-- ローカルと PR Preview の開発データが「分類なし」の状態だった（#2175 で修正）。
-- 旧 tags の dev:api / dev:frontend という prefix 表現は、そのまま
-- カテゴリー「開発」配下の 2 アクティビティへ展開する。

INSERT INTO public.categories (id, user_id, name, color) VALUES
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '開発', 'blue'),
  ('c0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '仕事', 'orange'),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '自己投資', 'green'),
  ('c0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'プライベート', 'pink')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.activities (id, user_id, category_id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'API開発'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'フロントエンド開発'),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'ミーティング'),
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', '学習'),
  ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'プライベート')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Plan / Record（初回ユーザー作成日を終端とする固定の14日間）
-- ============================================================
-- 平日は4-6 timeblock/日、週末は1-2 timeblock/日

DO $$
DECLARE
  v_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_date DATE;
  v_anchor_date DATE;
  v_dow INT;
  v_activity_ids UUID[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    'a0000000-0000-0000-0000-000000000003',
    'a0000000-0000-0000-0000-000000000004',
    'a0000000-0000-0000-0000-000000000005'
  ];
BEGIN
  -- Keep the initial fixture window across days without deleting user edits.
  -- Auth created_at survives ON CONFLICT, unlike the wall clock on every push.
  SELECT (created_at AT TIME ZONE 'UTC')::DATE INTO STRICT v_anchor_date
  FROM auth.users WHERE id = v_user_id;
  IF v_anchor_date IS NULL THEN
    RAISE EXCEPTION 'seed fixture creation date is missing';
  END IF;
  FOR i IN 0..13 LOOP
    v_date := v_anchor_date - (13 - i);
    v_dow := EXTRACT(DOW FROM v_date)::INT; -- 0=Sun, 6=Sat

    -- Supabase re-runs branch seeds on each commit. Stable IDs and natural-key
    -- checks preserve already-seeded rows, including rows created by the old
    -- random-ID seed, without overwriting user-edited test data.
    INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
    SELECT
      md5(v_user_id::TEXT || ':' || v_date::TEXT || ':plan:' || seed.seed_key)::UUID,
      v_user_id,
      seed.title,
      (v_date::TEXT || ' ' || seed.start_time::TEXT)::TIMESTAMPTZ,
      (v_date::TEXT || ' ' || seed.end_time::TEXT)::TIMESTAMPTZ,
      v_activity_ids[seed.activity_index]
    FROM (
      VALUES
        ('api', 'API開発', TIME '09:00', TIME '11:00', 1, 'weekday', 'all'),
        ('standup', 'チームスタンドアップ', TIME '11:00', TIME '11:30', 3, 'weekday', 'all'),
        ('frontend', 'UIコンポーネント実装', TIME '13:00', TIME '15:00', 2, 'weekday', 'all'),
        ('typescript', 'TypeScript勉強会', TIME '15:30', TIME '16:30', 4, 'weekday', 'alternate'),
        ('personal', '個人プロジェクト', TIME '10:00', TIME '12:00', 5, 'weekend', 'all')
    ) AS seed(seed_key, title, start_time, end_time, activity_index, day_kind, frequency)
    WHERE seed.day_kind = CASE WHEN v_dow IN (0, 6) THEN 'weekend' ELSE 'weekday' END
      AND (seed.frequency = 'all' OR (seed.frequency = 'alternate' AND i % 2 = 0))
      AND NOT EXISTS (
        SELECT 1 FROM public.plans AS existing
        WHERE existing.user_id = v_user_id
          AND existing.title = seed.title
          AND existing.start_at = (v_date::TEXT || ' ' || seed.start_time::TEXT)::TIMESTAMPTZ
          AND existing.end_at = (v_date::TEXT || ' ' || seed.end_time::TEXT)::TIMESTAMPTZ
          AND existing.activity_id = v_activity_ids[seed.activity_index]
      )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.records (id, user_id, title, start_at, end_at, source, activity_id)
    SELECT
      md5(v_user_id::TEXT || ':' || v_date::TEXT || ':record:' || seed.seed_key)::UUID,
      v_user_id,
      seed.title,
      (v_date::TEXT || ' ' || seed.start_time::TEXT)::TIMESTAMPTZ,
      (v_date::TEXT || ' ' || seed.end_time::TEXT)::TIMESTAMPTZ,
      seed.source,
      v_activity_ids[seed.activity_index]
    FROM (
      VALUES
        ('api', 'API開発', TIME '09:00', TIME '11:00', 1, 'from_plan', 'weekday', 'all'),
        ('standup', 'チームスタンドアップ', TIME '11:00', TIME '11:30', 3, 'from_plan', 'weekday', 'all'),
        ('frontend', 'UIコンポーネント実装', TIME '13:00', TIME '15:00', 2, 'from_plan', 'weekday', 'all'),
        ('typescript', 'TypeScript勉強会', TIME '15:30', TIME '16:30', 4, 'from_plan', 'weekday', 'alternate'),
        ('urgent', '緊急バグ対応', TIME '16:30', TIME '17:30', 1, 'manual', 'weekday', 'every_third'),
        ('personal', '個人プロジェクト', TIME '10:00', TIME '12:00', 5, 'from_plan', 'weekend', 'all')
    ) AS seed(seed_key, title, start_time, end_time, activity_index, source, day_kind, frequency)
    WHERE seed.day_kind = CASE WHEN v_dow IN (0, 6) THEN 'weekend' ELSE 'weekday' END
      AND (
        seed.frequency = 'all'
        OR (seed.frequency = 'alternate' AND i % 2 = 0)
        OR (seed.frequency = 'every_third' AND i % 3 = 0)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.records AS existing
        WHERE existing.user_id = v_user_id
          AND existing.title = seed.title
          AND existing.start_at = (v_date::TEXT || ' ' || seed.start_time::TEXT)::TIMESTAMPTZ
          AND existing.end_at = (v_date::TEXT || ' ' || seed.end_time::TEXT)::TIMESTAMPTZ
          AND existing.source = seed.source
          AND existing.activity_id = v_activity_ids[seed.activity_index]
      )
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $$;
