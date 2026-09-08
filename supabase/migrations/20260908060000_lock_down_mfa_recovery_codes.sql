-- MFA リカバリコード表を認証主体から書けない credential store にする（#2618）
--
-- ## 何が問題だったか
--
-- `public.mfa_recovery_codes` は「MFA を解除してよいか」という認証判断の根拠でありながら、
-- 判断される当人（aal1 の `authenticated` JWT）が PostgREST 経由で直接 INSERT できた。
-- RLS の `WITH CHECK ((select auth.uid()) = user_id)` は自分の user_id なら通し、
-- policy も grant も assurance level を見ていない。加えて `code_hash` は salt なし・
-- ユーザー非束縛の HMAC なので、攻撃者は捨てアカウントで (平文, hash) の組を 1 つ学べる。
--
-- 結果、被害者のパスワードだけを知る攻撃者が
--   1. 捨てアカウントでコードを生成し `code_hash` を SELECT で読む
--   2. 被害者のパスワードで aal1 セッションを得る
--   3. その aal1 トークンで被害者の user_id の行を INSERT
--   4. `user.verifyRecoveryCode` を呼ぶ（aal1 でも通る唯一の procedure）
-- という順で、被害者の TOTP factor を全削除して MFA を恒久的に迂回できた。
--
-- ## 何を変えるか
--
-- 表を「認証主体から読み書きできない」側へ移す。`use_recovery_code`（消費）が既に採っている
-- service-role only の SECURITY DEFINER RPC という形に、生成と件数取得も揃える。
--
-- 1. anon / authenticated から table の全権限を REVOKE し、3 つの RLS policy を DROP する
--    （grant を落とせば policy は到達しないが、残すと「本人は読み書きできる」と誤読される）
-- 2. 生成を `replace_mfa_recovery_codes_v1`（service_role only）の裏へ移す
-- 3. `count_unused_recovery_codes` を SECURITY DEFINER にする。ブラウザから直接呼ぶ read で、
--    SELECT grant に依存していたため invoker のままでは 1 で壊れる。件数しか返さず、
--    呼び出し元の user_id 一致チェックは従来どおり残す
--
-- ハッシュのユーザー束縛（`HMAC(user_id || code)` 化）は既存コードの一斉無効化を伴うため
-- 本 migration には含めない。上記 1 で攻撃連鎖の 3（行の植え込み）が閉じるため、束縛は
-- 多層化として別途行う。
--
-- ## 先行 migration との関係
--
-- `20260810085344_revoke_excess_table_grants.sql` はこの表を「Tier 2 — RLS-backed
-- legitimate use」に分類し、anon / authenticated が SELECT / INSERT / UPDATE / DELETE を
-- 保持することを invariant として assert している。本 migration はその分類を Tier 1
-- （ブラウザロールは一切の権限を持たない）へ引き上げる。あちらの DO block は自分の適用時点の
-- 状態を検査するので、forward-only の適用順では引き続き pass する。

-- ---------------------------------------------------------------------------
-- 1. ブラウザロールからの到達を閉じる
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE public.mfa_recovery_codes FROM anon, authenticated;

-- REVOKE ALL ON TABLE は列レベル ACL（pg_attribute.attacl）を消さない。現時点で列 ACL は
-- 存在しないが、将来 GRANT (column) が足された時に table 単位の REVOKE だけでは塞げないため、
-- 列単位でも明示的に落とす（20260723233814 / 20260810085344 と同じ理由）。
REVOKE ALL (id, user_id, code_hash, used_at, created_at)
  ON TABLE public.mfa_recovery_codes FROM anon, authenticated;

DROP POLICY IF EXISTS "Users can view own recovery codes" ON public.mfa_recovery_codes;
DROP POLICY IF EXISTS "Users can insert own recovery codes" ON public.mfa_recovery_codes;
DROP POLICY IF EXISTS "Users can delete own recovery codes" ON public.mfa_recovery_codes;

-- RLS は有効なまま残す（service_role は RLS を迂回する。将来 policy を足す時の既定を
-- 「拒否」に保つため無効化しない）。

-- ---------------------------------------------------------------------------
-- 2. 生成を service-role only の RPC へ移す
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_mfa_recovery_codes_v1(
  p_user_id UUID,
  p_code_hashes TEXT[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  -- 呼び出し元は service_role のみ。アプリ側で AAL を検証してから呼ぶ前提で、
  -- 認証主体自身がこの経路に到達できないことをここで担保する（#2618）。
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service role required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22004';
  END IF;

  IF p_code_hashes IS NULL OR array_length(p_code_hashes, 1) IS NULL THEN
    RAISE EXCEPTION 'p_code_hashes must not be empty' USING ERRCODE = '22023';
  END IF;

  -- 再発行は「全消し → 入れ直し」を 1 tx で行う。旧コードが残ると、無効化したはずの
  -- コードで MFA を解除できる窓が開く。
  DELETE FROM public.mfa_recovery_codes WHERE user_id = p_user_id;

  INSERT INTO public.mfa_recovery_codes (user_id, code_hash)
  SELECT p_user_id, code_hash
  FROM unnest(p_code_hashes) AS code_hash;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_mfa_recovery_codes_v1(UUID, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_mfa_recovery_codes_v1(UUID, TEXT[]) TO service_role;

COMMENT ON FUNCTION public.replace_mfa_recovery_codes_v1(UUID, TEXT[]) IS
  'MFA リカバリコードを service_role 経由で一括再発行する（#2618）。認証主体は mfa_recovery_codes へ直接書けない。';

-- ---------------------------------------------------------------------------
-- 3. 件数取得を SECURITY DEFINER にする（SELECT grant を落とした分の補償）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.count_unused_recovery_codes(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- DEFINER 化により呼び出し元の権限で守られなくなるため、user_id の一致検査が唯一の
  -- 認可境界になる。返すのは件数のみで code_hash は返さない。
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
    AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Access denied: user_id mismatch';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id AND used_at IS NULL;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.count_unused_recovery_codes(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_unused_recovery_codes(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.count_unused_recovery_codes(UUID) IS
  '未使用リカバリコード数を返す。#2618 で SECURITY DEFINER 化（表の SELECT grant をブラウザロールから剥奪したため）。';

-- ---------------------------------------------------------------------------
-- 4. invariant（この migration が主張する保証をその場で検証する）
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  browser_role TEXT;
  target_privilege TEXT;
  column_name TEXT;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- 表単位
    FOREACH target_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(browser_role, 'public.mfa_recovery_codes', target_privilege) THEN
        RAISE EXCEPTION
          'invariant violated: % still holds % on public.mfa_recovery_codes',
          browser_role, target_privilege;
      END IF;
    END LOOP;

    -- 列単位（table 単位の REVOKE では消えない ACL を取りこぼさない）
    FOREACH column_name IN ARRAY ARRAY['id', 'user_id', 'code_hash', 'used_at', 'created_at'] LOOP
      IF has_column_privilege(browser_role, 'public.mfa_recovery_codes', column_name, 'SELECT')
        OR has_column_privilege(browser_role, 'public.mfa_recovery_codes', column_name, 'INSERT')
        OR has_column_privilege(browser_role, 'public.mfa_recovery_codes', column_name, 'UPDATE')
      THEN
        RAISE EXCEPTION
          'invariant violated: % still holds a column privilege on public.mfa_recovery_codes.%',
          browser_role, column_name;
      END IF;
    END LOOP;

    -- 生成 RPC への到達
    IF has_function_privilege(
      browser_role,
      'public.replace_mfa_recovery_codes_v1(uuid, text[])',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'invariant violated: % can execute public.replace_mfa_recovery_codes_v1',
        browser_role;
    END IF;
  END LOOP;

  -- policy が残っていると「本人が読み書きできる」と誤読される（grant が無いので実効はない）。
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mfa_recovery_codes'
  ) THEN
    RAISE EXCEPTION 'invariant violated: public.mfa_recovery_codes still has RLS policies';
  END IF;

  -- service_role 側は消費・再発行のために全 DML を保持していること。
  FOREACH target_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.mfa_recovery_codes', target_privilege) THEN
      RAISE EXCEPTION
        'invariant violated: service_role lost % on public.mfa_recovery_codes',
        target_privilege;
    END IF;
  END LOOP;

  -- 件数取得はブラウザから呼ぶので authenticated に残っていること。
  IF NOT has_function_privilege(
    'authenticated',
    'public.count_unused_recovery_codes(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'invariant violated: authenticated cannot execute count_unused_recovery_codes';
  END IF;
END;
$$;
