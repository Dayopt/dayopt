import 'server-only';

/**
 * tRPC Server-side Helpers（App Router用）
 *
 * React Server ComponentsでtRPCクエリをprefetchし、
 * HydrationBoundaryでクライアントに引き継ぐ
 *
 * @example
 * ```tsx
 * // Server Component (page.tsx)
 * import { createServerHelpers, HydrationBoundary, dehydrate } from '@/lib/trpc/server'
 *
 * export default async function Page() {
 *   const helpers = await createServerHelpers()
 *   await helpers.records.list.prefetch()
 *
 *   return (
 *     <HydrationBoundary state={dehydrate(helpers.queryClient)}>
 *       <ClientComponent />
 *     </HydrationBoundary>
 *   )
 * }
 * ```
 */

import { cookies } from 'next/headers';
import { cache } from 'react';

import { createServerClient } from '@supabase/ssr';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { createServerSideHelpers } from '@trpc/react-query/server';
import superjson from 'superjson';

import { env } from '@/env';
import type { Database } from '@/lib/database';
import type { Context } from '@/lib/trpc/context';
import { appRouter } from '@/lib/trpc/root';
import { resolveSessionAuthContext } from '@/lib/trpc/session-auth-context';

// Re-export for convenience
export { dehydrate, HydrationBoundary };

/**
 * React Server Component用のSupabaseクライアントを作成
 */
async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Componentからの呼び出しでは設定できない場合がある
          }
        },
      },
    },
  );
}

/**
 * Server Component用のtRPCコンテキストを作成
 */
async function createServerContext(): Promise<Context> {
  const supabase = await createSupabaseServerClient();
  const { userId, sessionId, mfaAssurance } = await resolveSessionAuthContext(supabase, 'rsc_trpc');

  // Server Componentではreq/resは不要なのでダミーを渡す
  return {
    req: {} as Context['req'],
    res: {} as Context['res'],
    requestStartedAt: Date.now(),
    userId,
    sessionId,
    mfaAssurance,
    supabase,
    authMode: 'session' as const, // Server Componentは常にsession認証
  };
}

/**
 * QueryClientのシングルトン（リクエストごとにキャッシュ）
 */
const getQueryClient = cache(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000, // 5分
        },
      },
    }),
);

/**
 * Server-side tRPC helpersを作成
 *
 * React.cache()でリクエストごとにメモ化
 * 同一リクエスト内で複数回呼ばれても同じインスタンスを返す
 */
export const createServerHelpers = cache(async () => {
  const ctx = await createServerContext();
  const queryClient = getQueryClient();

  const helpers = createServerSideHelpers({
    router: appRouter,
    ctx,
    transformer: superjson,
  });

  // Object.assignを使用してhelpersのプロパティを保持
  // スプレッド演算子ではtRPCのプロキシプロパティが失われる
  return Object.assign(helpers, { queryClient });
});
