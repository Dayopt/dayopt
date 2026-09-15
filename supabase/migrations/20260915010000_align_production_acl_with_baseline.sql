-- #2748: production の policy / grant / bucket / default privileges を repository baseline へ揃える。
--
-- production は squash 前の archived migration 履歴（supabase/migrations/_archive/）で構築され、
-- 00000000000000_baseline.sql から作る local / Preview と差分が残っていた。2026-09-14 に
-- production-schema-drift-audit.mjs が初めて production 全体を snapshot と比較して検出した
-- （Dashboard 編集ではない）。2026-09-15 に同じ generator の query で production を read-only
-- で render して diff した差分を、この migration が 1:1 で打ち消す。
--
-- 方針は「production を baseline（migration から構築した local）へ寄せる」。baseline を
-- production から再生成しない（docs/operations/monitoring.md）。local / Preview では全文 no-op で、
-- pnpm rls:snapshot:check が変わらないことがその証明になる。
--
-- local の成功は production の成功を証明しない（production にしか無い ACL を打ち消すため）。
-- 黙って効かなかった場合に備え、末尾の DO ブロックが aclexplode で production の結果を検査する。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =============================================================================
-- 1. user_settings: SELECT / INSERT / DELETE policy の role を authenticated に戻す
-- =============================================================================
-- _archive/20260127100000_optimize_rls_policies_auth_uid.sql が TO 句なしで作り直したため
-- production は {public}。所有者条件 auth.uid() = user_id は同じなので実効の読み書き範囲は
-- 変わらないが、anon を policy の対象から外す。UPDATE は 20260430000000 で既に揃っている。
-- 定義は baseline.sql の user_settings 節と同一。

DROP POLICY IF EXISTS "Users can view own settings" ON public.user_settings;
CREATE POLICY "Users can view own settings" ON public.user_settings
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own settings" ON public.user_settings;
CREATE POLICY "Users can insert own settings" ON public.user_settings
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own settings" ON public.user_settings;
CREATE POLICY "Users can delete own settings" ON public.user_settings
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- =============================================================================
-- 2. profiles: policy の式を baseline と同一にする
-- =============================================================================
-- production は _archive/20251024114638_rls_policies_complete.sql 由来で、
-- auth.uid() IS NOT NULL の冗長な前置、UPDATE の明示 WITH CHECK、service_role ALL の
-- WITH CHECK 省略を持つ。いずれも意味は同じ（NULL = id は真にならず、WITH CHECK 省略時は
-- USING が使われる）。定義は baseline.sql の profiles 節と同一。

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Service role has full access to profiles" ON public.profiles;
CREATE POLICY "Service role has full access to profiles" ON public.profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 3. attachments bucket: 許可 MIME から text/csv を外す
-- =============================================================================
-- _archive/20251218072948_create_attachments_bucket.sql が text/csv を含めていた。
-- product は attachments bucket へ upload しない（参照は account deletion の掃除だけ）。
-- 既存 object は変更しない。前例: 20260604230607 の UPDATE storage.buckets。

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'
]
WHERE id = 'attachments'
  AND allowed_mime_types IS DISTINCT FROM ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'
  ];

-- =============================================================================
-- 4. service_role の UPDATE（production の default ACL 由来）を外す
-- =============================================================================
-- 20260818130000 / 20260905090000 は REVOKE ALL を PUBLIC, anon, authenticated にだけ打ち、
-- service_role には SELECT, INSERT, DELETE だけを GRANT した（「UPDATE を与えない」設計）。
-- production では default ACL が service_role へ付けた UPDATE が残っていた。

REVOKE UPDATE ON TABLE public.plan_template_blocks, public.segment_activities
  FROM service_role;

-- =============================================================================
-- 5. service_role の function EXECUTE（production の default ACL 由来）を外す
-- =============================================================================
-- いずれも trigger 関数または storage policy から呼ばれる関数で、product / scripts から
-- RPC として呼ぶ箇所は無い（2026-09-15 grep）。trigger の発火は EXECUTE 権限を検査せず、
-- service_role は RLS を bypass するため storage policy 関数も評価しない。local には
-- この grant が無く、全 test がその状態で通っている。
--
-- calculate_and_check_tag_depth / ensure_default_calendar / generate_simple_session_number は
-- archived 履歴にだけ存在し baseline に無い（production にだけ残る旧関数）。local / Preview には
-- 無いので存在する時だけ REVOKE する。旧関数の DROP は別の破壊的変更として扱い、ここでは
-- snapshot との差分（service_role の grant）だけを打ち消す。

DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.authorize_owned_storage_read_v1()',
    'public.authorize_owned_storage_write_v1()',
    'public.calculate_and_check_tag_depth()',
    'public.enforce_plan_skip_record_invariant_v1()',
    'public.ensure_default_calendar()',
    'public.generate_simple_session_number()',
    'public.validate_plan_temporal_write_v1()',
    'public.validate_record_temporal_write_v1()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION %s FROM service_role',
        pg_catalog.to_regprocedure(v_signature)
      );
    END IF;
  END LOOP;
END;
$$;

-- =============================================================================
-- 6. default privileges: postgres が public に作るオブジェクトの既定権限を local に揃える
-- =============================================================================
-- production は新規 table に anon / authenticated / service_role の全権限、sequence に
-- SELECT / USAGE、function に authenticated / service_role の EXECUTE を既定付与していた
-- （#1715 で記録した非対称）。local / Preview には無いので、新規オブジェクトの権限は
-- migration の明示 GRANT だけで決まる状態に production を寄せる。既存オブジェクトの ACL は
-- 変わらない。supabase_admin 所有の行は platform 管理で、既に一致している。

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, USAGE ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM authenticated, service_role;

-- =============================================================================
-- 7. Invariants
-- =============================================================================
-- has_*_privilege() は PUBLIC 経由の権限や role membership も数えるため、ここでは
-- 「この migration が外した直接 grant が残っていないか」を aclexplode で見る
-- （20260810085344 の注記と同じく、自分で満たせる guard にする）。

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_count
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.user_settings'::regclass
    AND policy.polname IN (
      'Users can view own settings',
      'Users can insert own settings',
      'Users can delete own settings'
    )
    AND policy.polroles = ARRAY['authenticated'::regrole::oid];
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'user_settings policies are not scoped to authenticated (% of 3)', v_count;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_count
  FROM pg_catalog.pg_class AS relation
  CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
  WHERE relation.oid IN (
      'public.plan_template_blocks'::regclass,
      'public.segment_activities'::regclass
    )
    AND acl.grantee = 'service_role'::regrole::oid
    AND acl.privilege_type = 'UPDATE';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'service_role still holds UPDATE on append-only tables (% grants)', v_count;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_count
  FROM pg_catalog.pg_proc AS routine
  CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) AS acl
  WHERE routine.oid IN (
      SELECT pg_catalog.to_regprocedure(signature)::oid
      FROM pg_catalog.unnest(ARRAY[
        'public.authorize_owned_storage_read_v1()',
        'public.authorize_owned_storage_write_v1()',
        'public.calculate_and_check_tag_depth()',
        'public.enforce_plan_skip_record_invariant_v1()',
        'public.ensure_default_calendar()',
        'public.generate_simple_session_number()',
        'public.validate_plan_temporal_write_v1()',
        'public.validate_record_temporal_write_v1()'
      ]) AS signature
      WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL
    )
    AND acl.grantee = 'service_role'::regrole::oid;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'service_role still holds EXECUTE on internal functions (% grants)', v_count;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_count
  FROM pg_catalog.pg_default_acl AS default_acl
  CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
  WHERE default_acl.defaclrole = 'postgres'::regrole::oid
    AND default_acl.defaclnamespace = 'public'::regnamespace::oid
    AND (
      (
        default_acl.defaclobjtype = 'r'
        AND acl.grantee IN (
          'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid
        )
        AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      )
      OR (
        default_acl.defaclobjtype = 'S'
        AND acl.grantee IN (
          'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid
        )
        AND acl.privilege_type IN ('SELECT', 'USAGE')
      )
      OR (
        default_acl.defaclobjtype = 'f'
        AND acl.grantee IN ('authenticated'::regrole::oid, 'service_role'::regrole::oid)
        AND acl.privilege_type = 'EXECUTE'
      )
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'postgres default privileges in public still grant client roles (% entries)', v_count;
  END IF;
END;
$$;

COMMIT;
