-- `mfa_recovery_codes` の REVOKE に PUBLIC を含める（#2618 の追補）
--
-- 直前の `20260908060000_lock_down_mfa_recovery_codes.sql` は `anon` / `authenticated` だけを
-- REVOKE の対象にしていた。先例である `20260810085344_revoke_excess_table_grants.sql` は
-- 同じ表を含む REVOKE で `PUBLIC` を明示しており、その理由も本文に書かれている:
-- **production の `pg_default_acl` は新規 public テーブルへ PUBLIC 経由の grant を付けうるが、
-- local / Preview では付かない**（#1715）。PUBLIC 経由の grant が 1 つでも残っていると
-- `has_table_privilege('authenticated', ...)` は true のままなので、
--
-- - 認証主体が表へ到達できる（本来閉じたはずの経路が開いたまま）
-- - `20260908060000` 末尾の invariant DO block が `RAISE EXCEPTION` し、production への
--   適用が途中で止まる
--
-- のどちらかになる。local では PUBLIC grant が無いため、local の適用成功は根拠にならない。
--
-- PUBLIC に権限が無ければ REVOKE は no-op なので、この migration は安全に冪等。

REVOKE ALL ON TABLE public.mfa_recovery_codes FROM PUBLIC;
REVOKE ALL (id, user_id, code_hash, used_at, created_at)
  ON TABLE public.mfa_recovery_codes FROM PUBLIC;

DO $$
DECLARE
  browser_role TEXT;
  target_privilege TEXT;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH target_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(browser_role, 'public.mfa_recovery_codes', target_privilege) THEN
        RAISE EXCEPTION
          'invariant violated: % still holds % on public.mfa_recovery_codes (PUBLIC 経由の grant が残っている可能性)',
          browser_role, target_privilege;
      END IF;
    END LOOP;
  END LOOP;

  -- service_role 側は消費・再発行のために全 DML を保持していること。
  FOREACH target_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.mfa_recovery_codes', target_privilege) THEN
      RAISE EXCEPTION
        'invariant violated: service_role lost % on public.mfa_recovery_codes',
        target_privilege;
    END IF;
  END LOOP;
END;
$$;
