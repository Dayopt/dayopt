/**
 * tRPCサーバー設定
 * プロシージャ定義とコンテキスト管理
 */

import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';

import { type BillingAccess, type EntitlementKey } from '@dayopt/billing';

import { getBillingAccess } from '@/lib/billing/access-service';
import { requiresProductAccess } from '@/lib/billing/operation-access';
import { type SupportedScope } from '@/lib/oauth-server';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { trpcUserRateLimit } from '@/lib/rate-limit/upstash';
import { captureUnexpectedError } from '@/lib/sentry';
import { ServiceError } from '@/lib/trpc/errors';
import { createCallerFactory, createTRPCRouter, mergeRouters, t } from '@/lib/trpc/router';
import { isValidMfaAssuranceTransition } from '@/lib/trpc/session-auth-context';
export type { Context } from '@/lib/trpc/context';
// 1 画面読込で 15〜20 手続き（週表示の plans / records / externalCalendar.listEvents に
// サイドバー・settings・billing が乗る）を撃つ実装に対し、100/min は E2E だけでなく
// 週送りを連打する実ユーザーも届く値だった（2026-09-08、#2669 で trace 集計）。
// 300 でも 5 req/s なので乱用の上限は保つ。Upstash 側（`trpcUserRateLimit`）と揃える。
const USER_RATE_LIMIT = 300;
const USER_RATE_WINDOW_MS = 60 * 1000;
const userRequestLog = new Map<string, number[]>();

const MCP_TRPC_SCOPE_REQUIREMENTS: Partial<Record<string, SupportedScope>> = {
  'plans.list': 'read:entries',
  'plans.getById': 'read:entries',
  'records.list': 'read:entries',
  'records.getById': 'read:entries',
  'statistics.getMcpReview': 'read:stats',
  // segments.list tool が呼ぶ。セグメントはアクティビティの名前付きグループなので
  // read:activities の読み取り範囲に収まる（#2173）。
  'review.listSegments': 'read:activities',
  'activities.listActivities': 'read:activities',
  'activities.listCategories': 'read:activities',
  'timeblockContext.getConstraints': 'read:constraints',
};

const MFA_CHALLENGE_TRPC_PATHS = new Set(['user.verifyRecoveryCode']);

function isUserRateLimitedInMemory(userId: string): boolean {
  const now = Date.now();
  const timestamps = userRequestLog.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < USER_RATE_WINDOW_MS);
  recent.push(now);
  userRequestLog.set(userId, recent);

  // メモリリーク防止
  if (userRequestLog.size > 10000) {
    for (const [key, ts] of userRequestLog) {
      if (ts.every((t) => now - t > USER_RATE_WINDOW_MS)) {
        userRequestLog.delete(key);
      }
    }
  }

  return recent.length > USER_RATE_LIMIT;
}

async function isUserRateLimited(userId: string): Promise<boolean> {
  // Upstash が有効な場合は Redis ベースのレート制限を使用
  if (trpcUserRateLimit) {
    try {
      const { success } = await trpcUserRateLimit.limit(userId);
      return !success;
    } catch (error) {
      // Redis エラー時はインメモリにフォールバック（可用性優先）
      const original = error instanceof Error ? error : new Error('tRPC rate limit check failed');
      captureUnexpectedError(original, {
        feature: 'rate_limit',
        operation: 'trpc_user_rate_limit_check',
        source: 'upstash',
      });
      return isUserRateLimitedInMemory(userId);
    }
  }
  // Upstash 未設定時はインメモリ実装
  return isUserRateLimitedInMemory(userId);
}

/**
 * 認証が必要なプロシージャ
 */
export const protectedProcedure = t.procedure
  .meta({ auth: 'protected' })
  .use(async ({ ctx, next, path, type }) => {
    if (!ctx.userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        cause: new ServiceError('INVALID_TOKEN', 'Authentication required'),
      });
    }
    const userId = ctx.userId;

    if (ctx.authMode === 'oauth') {
      if (ctx.oauthExecution !== 'mcp_internal') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'OAuth tokens are accepted only through the MCP endpoint',
          cause: new ServiceError('FORBIDDEN', 'Public OAuth tRPC access denied'),
        });
      }
      const requiredScope = MCP_TRPC_SCOPE_REQUIREMENTS[path];
      if (!requiredScope || !ctx.oauthScopes?.includes(requiredScope)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'OAuth token scope does not allow this procedure',
          cause: new ServiceError('FORBIDDEN', 'OAuth scope denied'),
        });
      }
    }

    if (ctx.authMode === 'session') {
      const mfaAssurance = ctx.mfaAssurance;
      if (
        !mfaAssurance ||
        mfaAssurance.lookupFailed ||
        !isValidMfaAssuranceTransition(mfaAssurance.currentLevel, mfaAssurance.nextLevel)
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'MFA verification required',
          cause: new ServiceError('FORBIDDEN', 'MFA AAL lookup failed'),
        });
      }

      if (
        !MFA_CHALLENGE_TRPC_PATHS.has(path) &&
        mfaAssurance.currentLevel === 'aal1' &&
        mfaAssurance.nextLevel === 'aal2'
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'MFA verification required',
          cause: new ServiceError('FORBIDDEN', 'MFA AAL2 required'),
        });
      }
    }

    let billingAccess: BillingAccess | undefined;
    if (requiresProductAccess(path, type, ctx.authMode === 'oauth')) {
      billingAccess = await getBillingAccess(ctx.supabase, userId);
      if (!billingAccess.canUseProduct) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Product access has ended',
          cause: new ServiceError('BILLING_ACCESS_ENDED', 'Product access has ended'),
        });
      }
    }

    // write fence は rate limit 消費より前に確認する。fenced request が
    // ユーザー自身の rate limit budget を消費して、復旧直後に自分をロック
    // アウトする事態を避けるため。
    if (type === 'mutation' && (await isWriteFenceEnabled(ctx.supabase))) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Writes are temporarily paused for maintenance',
        cause: new ServiceError('WRITE_FENCED', 'Write fence is enabled'),
      });
    }

    // OAuth internal callerは認証済みMCP endpointの専用user limiterで一度だけ制限する。
    // ここでも消費するとentries.listが二重課金され、UI sessionともbucketが干渉する。
    if (ctx.authMode !== 'oauth' && (await isUserRateLimited(userId))) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again later.',
      });
    }

    // Request-localなscopeに内部IDだけを設定し、並行requestへ漏らさない。
    return Sentry.withIsolationScope(async (scope) => {
      scope.setUser({ id: userId });
      return next({
        ctx: {
          ...ctx,
          userId,
          billingAccess,
        },
      });
    });
  });

/** Compatibility for existing callers; operation-access owns authorization. */
export function entitledProcedure(_key: EntitlementKey) {
  return protectedProcedure.meta({ auth: 'pro' }).use(async ({ ctx, next }) => {
    const access = ctx.billingAccess ?? (await getBillingAccess(ctx.supabase, ctx.userId));
    if (!access.canUseProduct) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Product access has ended',
        cause: new ServiceError('BILLING_ACCESS_ENDED', 'Product access has ended'),
      });
    }
    return next({ ctx });
  });
}

/**
 * ルーター作成関数
 */
export { createCallerFactory, createTRPCRouter, mergeRouters };
