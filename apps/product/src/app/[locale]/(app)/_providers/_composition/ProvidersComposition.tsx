/**
 * 認証必須ページ用Providersの実体
 *
 * @description
 * - Query Client / tRPC / Theme / AuthInit / Service Worker / モーダル Provider を
 *   1 箇所で合成し、呼び出し側の app/page から分離する。
 */
'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

import {
  CACHE_BUSTER,
  createUserScopedQueryPersister,
  PERSIST_MAX_AGE_MS,
} from '@/lib/tanstack-query/persist-storage';
import { shouldPersistQuery } from '@/lib/tanstack-query/should-persist-query';

// axe-core アクセシビリティチェッカー: 開発環境のみ
const AxeAccessibilityChecker =
  process.env.NODE_ENV === 'development'
    ? dynamic(
        () =>
          import('@/lib/dev/AxeAccessibilityChecker').then((mod) => mod.AxeAccessibilityChecker),
        {
          ssr: false,
        },
      )
    : () => null;

import { AuthStoreInitializer, waitForResolvedUserId } from '@/features/auth';
import { UserSettingsInitializer } from '@/features/settings';
import { api } from '@/lib/trpc';
import { createAppTrpcClient } from '@/lib/trpc/browser-client';
import { createAppQueryClient } from '@/lib/trpc/query-client';
import { ThemeProvider } from '../theme-provider';
import { QueryCacheAuthBoundary } from './QueryCacheAuthBoundary';

// SessionMonitorProviderを遅延ロード（セッション失効通知 + タイムアウト警告）
const SessionMonitorProvider = dynamic(
  () => import('@/features/auth').then((mod) => mod.SessionMonitorProvider),
  { ssr: false },
);

// ServiceWorkerProviderを遅延ロード（PWAインストール・静的キャッシュ・更新通知）
const ServiceWorkerProvider = dynamic(
  () => import('../ServiceWorkerProvider').then((mod) => mod.ServiceWorkerProvider),
  { ssr: false },
);

// アクティビティ作成モーダルを遅延ロード
const GlobalActivityCreateModal = dynamic(
  () =>
    import('@/features/activities/components/GlobalActivityCreateModal').then(
      (mod) => mod.GlobalActivityCreateModal,
    ),
  { ssr: false },
);

// アクティビティ改名モーダルを遅延ロード
const GlobalActivityRenameModal = dynamic(
  () =>
    import('@/features/activities/components/GlobalActivityRenameModal').then(
      (mod) => mod.GlobalActivityRenameModal,
    ),
  { ssr: false },
);

// カテゴリー改名モーダルを遅延ロード
const GlobalCategoryRenameModal = dynamic(
  () =>
    import('@/features/activities/components/GlobalCategoryRenameModal').then(
      (mod) => mod.GlobalCategoryRenameModal,
    ),
  { ssr: false },
);

interface ProvidersCompositionProps {
  children: React.ReactNode;
}

/** 認証必須ページ用フルProviders（composition 本体） */
export function ProvidersComposition({ children }: ProvidersCompositionProps) {
  const [queryClient] = useState(() => createAppQueryClient());
  const [trpcClient] = useState(() => createAppTrpcClient());
  // 永続化 cache は認証済み user ごとに分ける（#2619）。復元は auth store が session を
  // 読み終えるまで待つので、user が確定する前に他人の blob を hydrate することはない。
  const [queryPersister] = useState(() =>
    createUserScopedQueryPersister({ resolveUserId: waitForResolvedUserId }),
  );

  // Provider階層（最適化済み）
  // Context Provider: PersistQueryClientProvider → api.Provider → ThemeProvider
  // 非Context: AuthStoreInitializer（並列配置）
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        // QueryClient のデフォルト gcTime（2時間）に合わせ、タブを閉じても復元できる期間を確保
        maxAge: PERSIST_MAX_AGE_MS,
        // デプロイ毎にキャッシュを破棄（stale なキャッシュを本番で表示しないため）
        buster: CACHE_BUSTER,
        dehydrateOptions: {
          // 成功・データあり、かつ persist=false でないqueryだけを永続化する。
          shouldDehydrateQuery: shouldPersistQuery,
          // mutation は永続化しない
          shouldDehydrateMutation: () => false,
        },
      }}
    >
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {/* 認証ストア初期化（Contextを提供しないので並列配置可能） */}
        <AuthStoreInitializer />
        {/* 認証主体が変わったら memory / 永続 cache を破棄する（#2619） */}
        <QueryCacheAuthBoundary />
        <ThemeProvider>
          <SessionMonitorProvider>
            <ServiceWorkerProvider>
              {/* UserSettings の hydration が完了するまで children を render しない。
                  timezone 等が defaults のまま timezone-dependent mutation が実行
                  されるのを防ぐ。TanStack Query の永続 cache が効けば体感遅延は極小。 */}
              <UserSettingsInitializer>{children}</UserSettingsInitializer>
              <GlobalActivityCreateModal />
              <GlobalActivityRenameModal />
              <GlobalCategoryRenameModal />
            </ServiceWorkerProvider>
          </SessionMonitorProvider>
        </ThemeProvider>
        {/* 開発ツール（開発環境のみ） */}
        {process.env.NODE_ENV === 'development' && <AxeAccessibilityChecker />}
      </api.Provider>
    </PersistQueryClientProvider>
  );
}
