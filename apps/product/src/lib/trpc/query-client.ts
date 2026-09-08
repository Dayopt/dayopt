'use client';

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';

import { isBillingAccessEndedError } from '@/lib/billing/client-access-error';
import { PERSIST_MAX_AGE_MS } from '@/lib/tanstack-query/persist-storage';
import { captureUnexpectedTrpcClientFailure } from '@/lib/trpc/client-errors';

/**
 * 認証エラーかどうかを判定
 * UNAUTHORIZED(401)エラーの場合はログインページへリダイレクト
 */
function isAuthError(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    // tRPCエラーの場合、data.codeまたはHTTPステータスをチェック
    const code = error.data?.code;
    if (code === 'UNAUTHORIZED') return true;

    // HTTPステータスコードもチェック
    const httpStatus = error.data?.httpStatus;
    if (httpStatus === 401) return true;
  }
  return false;
}

/**
 * ユーザー単位の rate limit（`TOO_MANY_REQUESTS` / 429）かどうかを判定。
 * 超過中に retry すると同じ窓の budget をさらに消費して復旧を遅らせるだけなので、
 * 即座に諦めて次の自然な refetch に任せる（#2669）。
 */
function isRateLimitedError(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    if (error.data?.code === 'TOO_MANY_REQUESTS') return true;
    if (error.data?.httpStatus === 429) return true;
  }
  return false;
}

/**
 * 認証エラー時にログインページへリダイレクト
 */
function handleAuthError(error: unknown): void {
  if (typeof window === 'undefined') return;

  if (isAuthError(error)) {
    // 現在のパスのみ保存(query stringは含めない — 2次オープンリダイレクト防止)
    const currentPath = window.location.pathname;
    const loginUrl = `/auth/login?redirect=${encodeURIComponent(currentPath)}`;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 認証エラー時は全クライアント状態（tRPC cache / query client）を確実に破棄するためハードリロードが意図的
    window.location.href = loginUrl;
  }
}

/**
 * 認証必須ページ用の QueryClient を生成する
 *
 * グローバルエラーハンドリング: 認証エラー時は自動でログインページへリダイレクト
 */
export function createAppQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        handleAuthError(error);
        if (isBillingAccessEndedError(error))
          void queryClient.invalidateQueries({ queryKey: [['billing', 'getAccess']] });
        captureUnexpectedTrpcClientFailure(error, {
          feature: 'trpc',
          operation: 'query_cache',
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        handleAuthError(error);
        if (isBillingAccessEndedError(error))
          void queryClient.invalidateQueries({ queryKey: [['billing', 'getAccess']] });
        captureUnexpectedTrpcClientFailure(error, {
          feature: 'trpc',
          operation: 'mutation_cache',
        });
      },
    }),
    defaultOptions: {
      queries: {
        networkMode: 'offlineFirst', // オフライン時もキャッシュデータを表示
        staleTime: 5 * 60 * 1000, // 5分(一般的なデータのデフォルト)
        // PERSIST_MAX_AGE_MS(2時間)以上にする必要がある。
        // 永続化から復元されたデータが GC される前に読み込まれるために必須。
        gcTime: PERSIST_MAX_AGE_MS, // 2時間(query cache の IndexedDB 永続化)
        refetchOnWindowFocus: true, // 業界標準:タブ切り替え時にstaleなデータのみ再フェッチ
        refetchOnReconnect: 'always',
        retry: (failureCount, error) => {
          // 認証エラーはリトライしない(すぐにリダイレクト)。rate limit 超過も
          // リトライすると budget を食い潰すだけなので諦める
          if (isAuthError(error) || isBillingAccessEndedError(error) || isRateLimitedError(error))
            return false;
          // 404もリトライしない
          if (error && 'status' in error && error.status === 404) return false;
          return failureCount < 3;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      },
      mutations: {
        retry: (failureCount, error) => {
          // 認証エラーはリトライしない
          if (isAuthError(error) || isBillingAccessEndedError(error) || isRateLimitedError(error))
            return false;
          return failureCount < 1;
        },
      },
    },
  });
  return queryClient;
}
