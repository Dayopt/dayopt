-- avatars の object key を `<uid>/avatar.<ext>` に限定する（#2460）
--
-- ## 何が問題か
--
-- `avatars` の書き込み policy は `(storage.foldername(name))[1] = auth.uid()::TEXT`、つまり
-- **先頭のパス要素**しか見ていない。`<uid>/` 配下なら任意のファイル名・任意の深さが通るため、
-- 認証済みユーザー 1 人が 5MiB の object を無制限に積める（`file_size_limit` は 1 object の
-- 上限にすぎない）。アプリ経由ではなく Storage API を直接叩く経路の話で、storage 容量・
-- egress・Image Optimization の課金に効く。
--
-- ## 何を変えるか
--
-- 書き込み系（INSERT / UPDATE の WITH CHECK）に key の形を足し、アプリが実際に作る
-- `<uid>/avatar.<ext>`（`apps/product/src/lib/supabase/storage.ts` の `uploadAvatar`）だけを
-- 許す。拡張子はアプリの allowlist（jpg / jpeg / png / gif / webp）と bucket の
-- `allowed_mime_types`（`supabase/config.toml`）に揃える。
--
-- 結果、1 ユーザーが作れる object は最大 5 個（拡張子ごとに 1 つ）に有界化する。quota 機構や
-- rate limit は入れない — 上限 5 個で failure class が閉じるため（#2460 の YAGNI 注記）。
--
-- ## 変えないもの
--
-- - **SELECT / DELETE の USING 句**。旧形式の key（過去に直接 API で作られた object、
--   拡張子変更で孤児になった `<uid>/avatar.png` 等）を `deleteAvatar` が列挙して削除できる
--   必要がある。ここを絞ると回収不能な object が残る
-- - **UPDATE の USING 句**。既存 object を対象に取れなくなると upsert が壊れる。制限は
--   WITH CHECK（書き込み後の姿）側だけで足りる
-- - account deletion fence（`authorize_owned_storage_write_v1` / `_read_v1`）と policy 名。
--   policy 名は `scripts/lib/storage-objects-app-policy-names.mjs` の allow-list が正本で、
--   `production-storage-rls-audit.mjs` と `generate-rls-snapshot.ts` の両方が参照する

DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;

CREATE POLICY "Users can upload own avatar"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::TEXT
  AND name ~ ('^' || auth.uid()::TEXT || '/avatar\.(jpg|jpeg|png|gif|webp)$')
  AND public.authorize_owned_storage_write_v1()
);

CREATE POLICY "Users can update own avatar"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::TEXT
  AND public.authorize_owned_storage_write_v1()
)
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::TEXT
  AND name ~ ('^' || auth.uid()::TEXT || '/avatar\.(jpg|jpeg|png|gif|webp)$')
  AND public.authorize_owned_storage_write_v1()
);

-- invariant: app 所有の policy 8 本が揃っていること（20260823063536 と同じ形）。
-- DROP → CREATE の綴り間違いで policy が消えたまま適用されるのを防ぐ。
DO $$
DECLARE
  v_policy_count INTEGER;
BEGIN
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname IN (
      'Users can upload own avatar',
      'Users can update own avatar',
      'Users can delete own avatar',
      'Users can view own avatar',
      'Users can upload own attachments',
      'Users can update own attachments',
      'Users can delete own attachments',
      'Users can view own attachments'
    );

  IF v_policy_count <> 8 THEN
    RAISE EXCEPTION
      'invariant violated: expected 8 app-owned storage.objects policies, found %',
      v_policy_count;
  END IF;
END;
$$;
