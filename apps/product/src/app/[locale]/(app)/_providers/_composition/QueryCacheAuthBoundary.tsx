/**
 * 認証主体が変わったら query cache を捨てる境界（#2619）。
 *
 * @description
 * 永続化 cache は user 単位に名前空間を分けてあるが、それだけでは 2 つ穴が残る:
 *
 * 1. **メモリ上の QueryClient** は sign-out しても生き続ける。ログアウトは soft navigation
 *    （`router.push`）なので、同じタブで別ユーザーがログインすると前ユーザーの query が
 *    `staleTime` 内なら refetch されずに描画されうる
 * 2. **ディスク上の blob** は、ログアウト経路が複数（`useLogout` / 設定画面の複製 /
 *    session timeout / アカウント削除）あるため、どれか 1 つに掃除を書いても漏れる
 *
 * auth store の user id 遷移を 1 箇所で購読して両方を閉じる。sign-out の実装がどこにあっても、
 * 最終的に `supabase.auth.signOut()` → store の user が null になる経路を必ず通る。
 */
'use client';

import { useEffect, useRef } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { useAuthStore } from '@/features/auth';
import { clearPersistedQueryCache } from '@/lib/tanstack-query/persist-storage';

/** 認証主体の変化で cache を破棄する（描画には関与しない） */
export function QueryCacheAuthBoundary() {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const loading = useAuthStore((state) => state.loading);
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    // 初期解決の前（loading 中）は「変化」と見なさない。null → userId の初回遷移で
    // 復元直後の cache を消してしまうため。
    if (loading) return;

    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = userId;

    // 前の主体が居ない（初回解決）か、同一主体なら何もしない。
    if (previousUserId === null || previousUserId === userId) return;

    // ログアウト（userId === null）とユーザー切り替えの両方をここで閉じる。
    queryClient.clear();
    void clearPersistedQueryCache();
  }, [loading, queryClient, userId]);

  return null;
}
