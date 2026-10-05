/**
 * tRPC HTTP エンドポイント
 *
 * すべての tRPC procedure (app/api/trpc/_server/app-router.ts の appRouter) を
 * このルート 1 本で受ける。
 * - ルーティング: `/api/trpc/{procedure-path}` → router 経由で対応する procedure を呼出
 * - context: `createFetchTRPCContext` で Supabase auth から userId を解決
 * - エラー: error をログに記録（input は dev のみ展開、prod は REDACTED）
 * - cache: 認証済みは `private, no-store`、未認証は `no-cache` を返す
 *
 * @see https://trpc.io/docs/server/adapters/fetch
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { after } from 'next/server';

import { countSuccessfulCheckoutStarts } from '@/app/api/trpc/_server/_composition/checkout-product-events';
import { appRouter } from '@/app/api/trpc/_server/app-router';
import { trackProductEvents } from '@/lib/analytics/product-events';
import { logger } from '@/lib/logger';
import { createFetchTRPCContext } from '@/lib/trpc/context';
import { captureUnexpectedTrpcAdapterError } from '@/lib/trpc/errors';
import { rejectCrossOriginMutation } from '@/lib/trpc/http-mutation-origin';

export const runtime = 'nodejs';
/**
 * 全 procedure を 1 function で捌くため、最長 procedure に律速される。`externalCalendar` の
 * `syncNow` / `updateSelectedCalendars` が呼ぶ `syncConnection` は、この route の maxDuration
 * を 300 に張り付かせていた唯一の既知の理由だった（deadline がカレンダー・ページ単位の
 * ループを尊重しなかったため）。#1965 で `syncConnection` に wall-clock 予算を持たせ、
 * router.ts が `deadlineAt` を渡すようになったので 60 へ落とせる。
 */
export const maxDuration = 60;

function handler(req: Request) {
  const rejected = rejectCrossOriginMutation(req);
  if (rejected) return rejected;

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    // Clientはquery inputをURLへ残さないため、queryもPOSTで送る。
    allowMethodOverride: true,
    createContext: createFetchTRPCContext,
    onError: ({ error, type, path }) => {
      captureUnexpectedTrpcAdapterError(error, path ?? 'unknown');
      logger.error('tRPC request failed', {
        type,
        path,
        code: error.code,
      });
    },
    responseMeta: ({ ctx, data, eagerGeneration, paths }) => {
      const isAuthenticated = !!ctx?.userId;
      const checkoutStartedCount = countSuccessfulCheckoutStarts({
        data,
        eagerGeneration,
        paths,
      });

      if (ctx?.userId && checkoutStartedCount > 0) {
        const userId = ctx.userId;
        after(() =>
          trackProductEvents(
            Array.from({ length: checkoutStartedCount }, () => ({
              eventName: 'checkout_started' as const,
              userId,
            })),
          ),
        );
      }

      return {
        headers: {
          'cache-control': isAuthenticated ? 'private, no-store' : 'no-cache',
        },
      };
    },
  });
}

export { handler as GET, handler as POST };
