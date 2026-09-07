-- ============================================================
-- Dayopt local / PR Preview 用シードデータ
-- ============================================================
-- `supabase db reset` や Supabase Preview Branch 作成時に読み込まれる。
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
  'test@dayopt.dev',
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
);

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
  'test@dayopt.dev',
  'email',
  '{"sub": "00000000-0000-0000-0000-000000000001", "email": "test@dayopt.dev"}',
  now(),
  now(),
  now()
);

-- NOTE: profiles は auth.users INSERT 時に handle_new_user() トリガーで自動作成

-- ============================================================
-- ユーザー設定
-- ============================================================

INSERT INTO public.user_settings (user_id, timezone, time_format, week_starts_on, default_duration)
VALUES ('00000000-0000-0000-0000-000000000001', 'Asia/Tokyo', '24h', 1, 60);

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
  ('c0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'プライベート', 'pink');

INSERT INTO public.activities (id, user_id, category_id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'API開発'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'フロントエンド開発'),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'ミーティング'),
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', '学習'),
  ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'プライベート');

-- ============================================================
-- Plan / Record（2週間分: 今日を基準に14日前〜今日）
-- ============================================================
-- 平日は4-6 timeblock/日、週末は1-2 timeblock/日

DO $$
DECLARE
  v_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_date DATE;
  v_dow INT;
  v_activity_ids UUID[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    'a0000000-0000-0000-0000-000000000003',
    'a0000000-0000-0000-0000-000000000004',
    'a0000000-0000-0000-0000-000000000005'
  ];
BEGIN
  FOR i IN 0..13 LOOP
    v_date := CURRENT_DATE - (13 - i);
    v_dow := EXTRACT(DOW FROM v_date)::INT; -- 0=Sun, 6=Sat

    IF v_dow NOT IN (0, 6) THEN
      -- 平日: 朝の集中タイム (9:00-11:00) → dev:api
      INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
      VALUES (gen_random_uuid(), v_user_id, 'API開発',
        (v_date || ' 09:00:00')::TIMESTAMPTZ,
        (v_date || ' 11:00:00')::TIMESTAMPTZ,
        v_activity_ids[1]);
      INSERT INTO public.records (
        user_id, title, start_at, end_at, source, activity_id
      ) VALUES (
        v_user_id, 'API開発',
        (v_date || ' 09:00:00')::TIMESTAMPTZ,
        (v_date || ' 11:00:00')::TIMESTAMPTZ,
        'from_plan', v_activity_ids[1]
      );

      -- 午前ミーティング (11:00-12:00)
      INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
      VALUES (gen_random_uuid(), v_user_id, 'チームスタンドアップ',
        (v_date || ' 11:00:00')::TIMESTAMPTZ,
        (v_date || ' 11:30:00')::TIMESTAMPTZ,
        v_activity_ids[3]);
      INSERT INTO public.records (
        user_id, title, start_at, end_at, source, activity_id
      ) VALUES (
        v_user_id, 'チームスタンドアップ',
        (v_date || ' 11:00:00')::TIMESTAMPTZ,
        (v_date || ' 11:30:00')::TIMESTAMPTZ,
        'from_plan', v_activity_ids[3]
      );

      -- 午後のフロントエンド開発 (13:00-15:00)
      INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
      VALUES (gen_random_uuid(), v_user_id, 'UIコンポーネント実装',
        (v_date || ' 13:00:00')::TIMESTAMPTZ,
        (v_date || ' 15:00:00')::TIMESTAMPTZ,
        v_activity_ids[2]);
      INSERT INTO public.records (
        user_id, title, start_at, end_at, source, activity_id
      ) VALUES (
        v_user_id, 'UIコンポーネント実装',
        (v_date || ' 13:00:00')::TIMESTAMPTZ,
        (v_date || ' 15:00:00')::TIMESTAMPTZ,
        'from_plan', v_activity_ids[2]
      );

      -- 午後の学習 (15:30-16:30) — 隔日
      IF i % 2 = 0 THEN
        INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
        VALUES (gen_random_uuid(), v_user_id, 'TypeScript勉強会',
          (v_date || ' 15:30:00')::TIMESTAMPTZ,
          (v_date || ' 16:30:00')::TIMESTAMPTZ,
          v_activity_ids[4]);
        INSERT INTO public.records (
          user_id, title, start_at, end_at, source, activity_id
        ) VALUES (
          v_user_id, 'TypeScript勉強会',
          (v_date || ' 15:30:00')::TIMESTAMPTZ,
          (v_date || ' 16:30:00')::TIMESTAMPTZ,
          'from_plan', v_activity_ids[4]
        );
      END IF;

      -- 突発タスク（一部の日のみ）は Record だけを作る
      IF i % 3 = 0 THEN
        INSERT INTO public.records (
          user_id, title, start_at, end_at, activity_id
        ) VALUES (v_user_id, '緊急バグ対応',
          (v_date || ' 16:30:00')::TIMESTAMPTZ,
          (v_date || ' 17:30:00')::TIMESTAMPTZ,
          v_activity_ids[1]);
      END IF;

    ELSE
      -- 週末: 個人タスク (10:00-12:00)
      INSERT INTO public.plans (id, user_id, title, start_at, end_at, activity_id)
      VALUES (gen_random_uuid(), v_user_id, '個人プロジェクト',
        (v_date || ' 10:00:00')::TIMESTAMPTZ,
        (v_date || ' 12:00:00')::TIMESTAMPTZ,
        v_activity_ids[5]);
      INSERT INTO public.records (
        user_id, title, start_at, end_at, source, activity_id
      ) VALUES (
        v_user_id, '個人プロジェクト',
        (v_date || ' 10:00:00')::TIMESTAMPTZ,
        (v_date || ' 12:00:00')::TIMESTAMPTZ,
        'from_plan', v_activity_ids[5]
      );
    END IF;
  END LOOP;
END $$;
