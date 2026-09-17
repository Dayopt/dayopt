-- 未使用の vault 経由 Edge 呼び出し関数と、それ専用の vault secret 2 件を撤去する（issue #2733）
--
-- 20260319000001 / 20260319000003 が入れた 2 関数は、互いを参照しているだけで
-- どこからも呼ばれていない。#2517（legacy JWT API keys 無効化、2026-09-14）の
-- production read-only 実測で確認した内容:
--
--   - cron.job は 5 本で、どれも Edge も pg_net も呼ばない
--   - net._http_response が存在しない（pg_net 自体が入っていない）。repo の
--     migration にも有効化が無い。つまり invoke_edge_function は呼ばれても
--     net.http_post で失敗する
--   - app / scripts / tests から 2 関数への .rpc 呼び出しはゼロ（rg で実測）
--
-- vault secret の service_role_key には無効化済みの legacy JWT が入っており
-- （推定。vault の値は権限不足で読めていない）、supabase_url と合わせて
-- invoke_edge_function 以外から読む経路が無い。
--
-- ⚠️ 不可逆な要素 ⚠️
-- vault.secrets の DELETE に逆 SQL は無い。ただし失う値は
--   - service_role_key: 無効化済みの legacy JWT（すでに使えない）
--   - supabase_url: 公開されている project URL
-- のみで、復元が必要になる筋書きは無い。必要なら vault.create_secret で作り直せる。
-- 2 関数の DROP は 20260319000001 / 20260319000003 の定義を再適用すれば戻る。
--
-- 残すもの:
--   - public.vault_secret_exists(TEXT) — #2733 の対象外。scripts/ci/db-upgrade-check.test.ts
--     が契約 fixture として名前を固定している
--   - 残り 7 件の vault secret（cron_secret / recovery_code_pepper / stripe_* /
--     resend_* / anthropic_api_key）— いずれも placeholder のままだが、本 issue の
--     scope 外なので触らない
--   - supabase_vault 拡張そのもの（20260319000000）
--
-- 旧アプリとの互換: 2 関数は TS から一度も呼ばれていないため、生成型から消えても
-- 旧 build の実行経路には無い。契約を縮める変更なので runtime コードとは PR を分けた
-- （check-destructive-migration.mjs の coupled 判定）。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- =============================================================================
-- 1. Edge 呼び出しと vault 読み出しの 2 関数を落とす
-- =============================================================================
-- exact signature で、IF EXISTS を付けない。既に消えていれば意図とずれているので
-- 気付けるように失敗させる（この repo の DROP FUNCTION の定型）。
-- ACL は object と一緒に消えるので先行する REVOKE は要らない。

DROP FUNCTION public.invoke_edge_function(TEXT, JSONB);
DROP FUNCTION public.get_vault_secret(TEXT);

-- =============================================================================
-- 2. 2 関数専用だった vault secret を落とす
-- =============================================================================

DELETE FROM vault.secrets WHERE name IN ('service_role_key', 'supabase_url');

-- =============================================================================
-- 3. 残存参照が無いことを表明する
-- =============================================================================
-- 他の関数本体が落とした名前を参照していれば、適用時点で気付けるようにする。
-- candidate を MATERIALIZED で先に確定させるのは、aggregate に pg_get_functiondef
-- が当たってエラーを投げるのを避けるため（20260903120000 と同じ理由）。

DO $$
DECLARE
  v_offenders text;
BEGIN
  IF pg_catalog.to_regprocedure('public.invoke_edge_function(text, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'public.invoke_edge_function still exists';
  END IF;

  IF pg_catalog.to_regprocedure('public.get_vault_secret(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'public.get_vault_secret still exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name IN ('service_role_key', 'supabase_url')
  ) THEN
    RAISE EXCEPTION 'vault secrets service_role_key / supabase_url still exist';
  END IF;

  WITH candidate AS MATERIALIZED (
    SELECT p.oid, n.nspname, p.proname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  )
  SELECT string_agg(
           c.nspname || '.' || c.proname || '(' ||
           pg_catalog.pg_get_function_identity_arguments(c.oid) || ')',
           ', ' ORDER BY c.nspname, c.proname
         )
    INTO v_offenders
    FROM candidate c
   WHERE pg_catalog.pg_get_functiondef(c.oid) ~ '\m(invoke_edge_function|get_vault_secret)\M';

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'residual reference to dropped vault objects in: %', v_offenders;
  END IF;
END $$;

COMMIT;
