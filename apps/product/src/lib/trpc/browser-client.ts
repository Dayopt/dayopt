'use client';

import { httpBatchLink, splitLink } from '@trpc/client';
import superjson from 'superjson';

import { api, getBaseUrl } from '@/lib/trpc';

/**
 * ブラウザ用 tRPC Client を生成する
 *
 * loggerLink は operation input(contact本文・email・password等)を console へ渡すため使わない。
 */
export function createAppTrpcClient() {
  const batchOptions = {
    url: `${getBaseUrl()}/api/trpc`,
    transformer: superjson,
    // Query input(検索語を含む)をURL・proxy logへ残さない。
    methodOverride: 'POST',
    headers() {
      const headers: Record<string, string> = {};
      if (typeof window !== 'undefined') {
        const token = localStorage.getItem('auth_token');
        if (token) {
          headers.authorization = `Bearer ${token}`;
        }
      }
      return headers;
    },
  } as const;

  return api.createClient({
    links: [
      // 全履歴の補助統計が表示範囲の batch response を待たせないよう分離する。
      splitLink({
        condition: (op) => op.type === 'query' && op.path === 'statistics.getActivityStats',
        true: httpBatchLink(batchOptions),
        false: httpBatchLink(batchOptions),
      }),
    ],
  });
}
