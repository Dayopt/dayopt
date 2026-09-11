/**
 * tRPC コンテキスト管理
 */

import 'server-only';

import { timingSafeEqual } from 'crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';

import { env } from '@/env';
import { type Database } from '@/lib/database';
import { logger } from '@/lib/logger';
import { extractBearerToken, verifyAccessToken } from '@/lib/mcp/auth';
import { OAuthServerError, type OAuthClientId, type SupportedScope } from '@/lib/oauth-server';
import { captureUnexpectedError } from '@/lib/sentry';
import { AuthMode, createServiceRoleClient, detectAuthMode } from '@/lib/supabase/oauth';
import { resolveSessionAuthContext, type MfaAssurance } from '@/lib/trpc/session-auth-context';

/**
 * リクエストコンテキストの型定義
 */
export interface TrpcRequestLike {
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
  socket?: {
    remoteAddress?: string | undefined;
  };
}

/** tRPCレスポンスの最低限のインターフェース */
export interface TrpcResponseLike {
  headers?: Headers;
  setHeader?: (name: string, value: string | readonly string[]) => void;
  end?: (...args: unknown[]) => void;
}

/** tRPCプロシージャのコンテキスト型 */
export interface Context {
  req: TrpcRequestLike;
  res: TrpcResponseLike;
  /**
   * この request の handler が呼ばれた時刻（`Date.now()` 換算、ms）。
   *
   * `externalCalendar.syncNow` / `updateSelectedCalendars`（#1965）が wall-clock 予算の
   * anchor に使う。auth 解決・rate limit 等より前に確定させないと、それらの所要時間
   * （worst case で数十秒）が予算計算から抜け落ち、maxDuration を超過しうる
   * （risk-reviewer 指摘、PR #2075）。
   */
  requestStartedAt: number;
  userId?: string | undefined;
  sessionId?: string | undefined;
  supabase: SupabaseClient<Database>;
  /** 認証モード（session, oauth, service-role） */
  authMode: AuthMode;
  /** OAuth 2.1トークン（oauth modeの場合のみ） */
  accessToken?: string | undefined;
  /** OAuth 2.1 client_id（oauth modeの場合のみ） */
  oauthClientId?: OAuthClientId | undefined;
  /** 検証済み OAuth scopes（oauth modeの場合のみ） */
  oauthScopes?: SupportedScope[] | undefined;
  /**
   * In-process MCP bridgeだけが設定する実行境界。
   * HTTP requestのheaderやbodyからは決して設定しない。
   */
  oauthExecution?: 'mcp_internal' | undefined;
  /** Supabase Auth MFA assurance level（session modeの場合のみ） */
  mfaAssurance?: MfaAssurance | undefined;
  /** JWTカスタムクレームから取得したサブスクリプション状態（custom_access_token hook） */
  subscriptionStatus?: string | undefined;
}

/**
 * コンテキスト作成関数
 *
 * 3つの認証モードをサポート：
 * 1. session: Cookie認証（既存、ブラウザ用）
 * 2. oauth: OAuth 2.1トークン認証（MCP用）
 * 3. service-role: Service Role Key認証（管理者用）
 */
async function createTRPCContext(opts: {
  req: TrpcRequestLike;
  res: TrpcResponseLike;
  requestStartedAt: number;
}): Promise<Context> {
  const { req, res, requestStartedAt } = opts;

  // リクエストヘッダーから認証モードを自動検出
  const authMode = detectAuthMode(req.headers as Record<string, string>);

  // 認証情報の取得
  let userId: string | undefined;
  let sessionId: string | undefined;
  let accessToken: string | undefined;
  let oauthClientId: OAuthClientId | undefined;
  let oauthScopes: SupportedScope[] | undefined;
  let mfaAssurance: Context['mfaAssurance'];
  let supabase: SupabaseClient<Database>;

  // 1. OAuth 2.1トークン認証（MCP用） — Dayopt 発行の opaque token を oauth_tokens 検証
  if (authMode === 'oauth') {
    try {
      const authHeader =
        typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null;
      const token = extractBearerToken(authHeader);
      const verified = await verifyAccessToken(token);

      userId = verified.userId;
      accessToken = token;
      oauthClientId = verified.clientId;
      oauthScopes = verified.scopes;
      // Opaque token は JWT ではないため subscription_status は entitledProcedure 側で
      // 必ず DB lookup する (Decision 1)。supabase は service-role client。
      supabase = createServiceRoleClient();
    } catch (error) {
      if (error instanceof OAuthServerError) {
        if (error.httpStatus >= 500) {
          const original = error.cause instanceof Error ? error.cause : error;
          captureUnexpectedError(original, {
            feature: 'mcp',
            operation: 'create_trpc_oauth_context',
          });
          logger.error('OAuth token verification failed');
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'OAuth authentication service unavailable',
            cause: error,
          });
        }
        logger.warn('OAuth access token rejected');
      } else {
        const original =
          error instanceof Error ? error : new Error('Unexpected OAuth authentication failure');
        captureUnexpectedError(original, {
          feature: 'mcp',
          operation: 'create_trpc_oauth_context',
        });
        logger.error('OAuth token verification failed');
      }
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'OAuth authentication failed',
        cause: error,
      });
    }
  }
  // 2. Service Role認証（管理者用）
  else if (authMode === 'service-role') {
    try {
      const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null;
      const expectedKey = env.SUPABASE_SECRET_KEY;

      if (!apiKey || !expectedKey || !safeCompare(apiKey, expectedKey)) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing API key',
        });
      }

      // Service Role Client作成（RLSバイパス）
      supabase = createServiceRoleClient();
      userId = undefined; // Admin操作ではuserIdはundefined
    } catch (error) {
      logger.error('Service role authentication failed', { error });
      throw error;
    }
  }
  // 3. Session Cookie認証（既存、ブラウザ用）
  else {
    const { createServerClient } = await import('@supabase/ssr');

    supabase = createServerClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        cookies: {
          getAll() {
            return Object.entries(req.cookies).map(([name, value]) => ({
              name,
              value: value ?? '',
            }));
          },
          setAll() {
            // tRPC API routes cannot set cookies (read-only context)
          },
        },
      },
    );

    const sessionAuthContext = await resolveSessionAuthContext(supabase, 'trpc_context');
    userId = sessionAuthContext.userId;
    sessionId = sessionAuthContext.sessionId;
    mfaAssurance = sessionAuthContext.mfaAssurance;
  }

  // JWTカスタムクレームからsubscription_statusを取得（custom_access_token hook）
  let subscriptionStatus: string | undefined;
  const tokenToDecode = accessToken ?? sessionId;
  if (tokenToDecode) {
    try {
      const payload = tokenToDecode.split('.')[1];
      if (payload) {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
          string,
          unknown
        >;
        subscriptionStatus =
          typeof claims['subscription_status'] === 'string'
            ? claims['subscription_status']
            : undefined;
      }
    } catch {
      // JWTデコード失敗時はundefined（entitledProcedureでフォールバック）
    }
  }

  return {
    req,
    res,
    requestStartedAt,
    userId,
    sessionId,
    accessToken,
    oauthClientId,
    oauthScopes,
    mfaAssurance,
    supabase,
    authMode,
    subscriptionStatus,
  };
}

/** Fetch API用tRPCコンテキスト作成（App Router Route Handler向け） */
export async function createFetchTRPCContext(opts: FetchCreateContextFnOptions): Promise<Context> {
  // handler が呼ばれた直後、auth 解決より前に anchor する（Context.requestStartedAt 参照）。
  const requestStartedAt = Date.now();
  const req = createRequestLike(opts.req);
  if (detectAuthMode(req.headers as Record<string, string>) === 'oauth') {
    // Dayopt発行のopaque tokenを受理する公開HTTP境界は /api/mcp だけに固定する。
    // ここでDB lookupより前に拒否し、未認証Bearer連打でservice-role検証を増幅させない。
    logger.warn('OAuth bearer rejected at public tRPC boundary');
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'OAuth tokens are accepted only through the MCP endpoint',
    });
  }

  return createTRPCContext({
    req,
    res: { headers: opts.resHeaders },
    requestStartedAt,
  });
}

function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function createRequestLike(req: Request): TrpcRequestLike {
  const headers = Object.fromEntries(
    Array.from(req.headers.entries(), ([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    headers,
    cookies: parseCookieHeader(req.headers.get('cookie')),
    signal: req.signal,
  };
}

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};

  for (const cookie of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (!rawName) continue;

    const value = rawValue.join('=') || '';

    try {
      cookies[rawName] = decodeURIComponent(value);
    } catch {
      cookies[rawName] = value;
    }
  }

  return cookies;
}
