/**
 * tRPC Router 初期化
 */

import 'server-only';

import { initTRPC, type TRPCDefaultErrorShape, type TRPCError } from '@trpc/server';
import superjson from 'superjson';

import { type ProductAccessLevel } from '@/lib/auth/domain';
import { getClientSafeServiceCode } from '@/lib/trpc/client-safe-service-code';
import type { Context } from '@/lib/trpc/context';

/**
 * プロシージャメタデータ（API仕様書自動生成用）
 */
interface ProcedureMeta {
  /** OpenAPI description */
  description?: string;
  /** 認証レベル */
  auth?: ProductAccessLevel;
  /** エンドポイント固有のレート制限（グローバル300 req/minを上書き） */
  rateLimit?: { requests: number; window: string };
  /** 非推奨フラグ */
  deprecated?: boolean;
}

/** プロダクションではサーバー起因エラーの詳細を隠す（DB情報漏洩防止） */
const SERVER_ERROR_CODES = new Set(['INTERNAL_SERVER_ERROR', 'TIMEOUT', 'CLIENT_CLOSED_REQUEST']);

/**
 * clientへ返すerror shapeを組み立てる。
 *
 * `create({ errorFormatter })` に渡す関数そのものをexportし、testが再実装なしで
 * 「clientに届いた時点のshape」を検証できるようにする（#1937）。
 */
export function formatTrpcError({
  error,
  shape,
}: {
  error: TRPCError;
  shape: TRPCDefaultErrorShape;
}) {
  const isProduction = process.env.NODE_ENV === 'production';

  const message =
    isProduction && SERVER_ERROR_CODES.has(error.code) ? 'サーバーエラーが発生した' : shape.message;

  return {
    ...shape,
    message,
    data: {
      ...shape.data,
      serviceCode: getClientSafeServiceCode(error.cause),
      // 開発環境でのみスタックトレースを含める
      stack: isProduction ? undefined : error.stack,
    },
  };
}

export const t = initTRPC.context<Context>().meta<ProcedureMeta>().create({
  transformer: superjson,
  errorFormatter: formatTrpcError,
});

/**
 * ルーター作成関数
 */
export const createTRPCRouter = t.router;

/**
 * プロシージャのマージ関数
 */
export const mergeRouters = t.mergeRouters;

/**
 * テスト用callerファクトリ
 */
export const createCallerFactory = t.createCallerFactory;
