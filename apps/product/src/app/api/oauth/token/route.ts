import { NextResponse, type NextRequest } from 'next/server';

import { logger } from '@/lib/logger';
import {
  OAuthServerError,
  exchangeAuthorizationCode,
  refreshAccessToken,
  resolveClient,
  resolveRequestedResource,
} from '@/lib/oauth-server';
import { rejectUnexpectedOAuthHost } from '@/lib/oauth-server/request-host';
import {
  checkOAuthTokenGrantRateLimit,
  checkOAuthTokenPreBodyRateLimit,
  type OAuthTokenRateLimitState,
} from '@/lib/oauth-server/token-rate-limit';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/**
 * RFC 6749 §3.2 - Token Endpoint
 *
 * POST application/x-www-form-urlencoded で grant_type に応じて token を発行する。
 *
 * Phase 1 で対応する grant_type:
 *   - authorization_code (PKCE 必須, code_verifier 検証)
 *   - refresh_token (rotation あり、旧 refresh は revoke)
 *
 * 認証は不要 (public client only — token endpoint auth method = "none")。
 * canonical public path は filesystem route の `/oauth/token`（`app/oauth/token/route.ts`
 * が本 handler を re-export）。この `/api/oauth/token` は互換のため残す。
 */
export const dynamic = 'force-dynamic';
/**
 * rate limit 2s + identity 15s + grant 消費 RPC 15s = 32s。
 *
 * 内側の上限は `lib/oauth-server/db.ts` の `OAUTH_DB_TIMEOUT_MS`。**そちらを先に発火
 * させる**のが要点で、ここが先に切れると 1 回しか使えない grant を消費したまま
 * レスポンスが返らず、client は再試行しても使用済みエラーで詰む。
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const hostRejection = rejectUnexpectedOAuthHost(request);
  if (hostRejection) return hostRejection;

  // grant 種別ごとに bucket を分けるには body が要るので、まず body 読み取り自体に
  // 粗い IP 上限を掛ける。DB を引く処理（fence 判定・grant 消費）は、その後段の
  // grant 別上限の内側にある。
  const preBodyState = await checkOAuthTokenPreBodyRateLimit(request);
  if (preBodyState !== 'allowed') return rateLimitErrorResponse(preBodyState);

  try {
    const form = await readFormBody(request);
    const get = (key: string): string | undefined => form.get(key) ?? undefined;
    const grantType = get('grant_type');

    const refreshToken = grantType === 'refresh_token' ? get('refresh_token') : undefined;
    const grantRateLimitState = await checkOAuthTokenGrantRateLimit(
      request,
      refreshToken ? { type: 'refresh_token', refreshToken } : { type: 'other' },
    );
    if (grantRateLimitState !== 'allowed') return rateLimitErrorResponse(grantRateLimitState);

    // write fence は **新規接続の作成（authorization_code）だけ**を止める。
    //
    // `refresh_token` を止めると、access token の寿命が 5 分なので fence が 5 分を超えた
    // 時点で read-only 接続も失効し、runbook §write fence の「読み取りは通したまま
    // 書き込みだけ止める」が MCP に対して成り立たなくなる（#2721 D-02）。
    // 一方 refresh を通しても write の露出は増えない — MCP 経由の書き込みは
    // `mcp_mutation_control` の別 gate が持ち、fence はもともとそこに効かない
    // （runbook の対象表）。つまり同じ接続は fence 中でも既存の access token で
    // 書けるので、rotation を拒んでも防げるものが無い。
    //
    // 書き込まれるのは `oauth_tokens` の rotation 行だけで、retention cleanup が掃く。
    //
    // rate limit の後に置く。fence 判定は service-role の DB 読取を伴うため、rate limit
    // より前に置くと未認証リクエストがそれを無制限に駆動できてしまう（増幅経路）。
    if (
      grantType === 'authorization_code' &&
      (await isWriteFenceEnabled(createServiceRoleClient()))
    ) {
      return writeFencedErrorResponse();
    }

    if (grantType === 'authorization_code') {
      const code = required(get('code'), 'code');
      const clientId = required(get('client_id'), 'client_id');
      const redirectUri = required(get('redirect_uri'), 'redirect_uri');
      const codeVerifier = required(get('code_verifier'), 'code_verifier');
      const resource = requiredResource(get('resource'));

      const client = resolveClient(clientId);
      if (!client) {
        throw new OAuthServerError('invalid_client', 'Unknown client_id');
      }

      const tokens = await exchangeAuthorizationCode({
        code,
        client_id: client.id,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource_uri: resource,
      });
      return tokenResponse(tokens);
    }

    if (grantType === 'refresh_token') {
      const presentedRefreshToken = required(refreshToken, 'refresh_token');
      const clientId = required(get('client_id'), 'client_id');
      const resource = requiredResource(get('resource'));

      const client = resolveClient(clientId);
      if (!client) {
        throw new OAuthServerError('invalid_client', 'Unknown client_id');
      }

      const tokens = await refreshAccessToken({
        refresh_token: presentedRefreshToken,
        client_id: client.id,
        resource_uri: resource,
      });
      return tokenResponse(tokens);
    }

    throw new OAuthServerError(
      'unsupported_grant_type',
      `grant_type "${grantType ?? '(missing)'}" is not supported`,
    );
  } catch (err) {
    if (err instanceof OAuthServerError) {
      if (err.httpStatus >= 500) {
        const original = err.cause instanceof Error ? err.cause : err;
        captureUnexpectedError(original, {
          feature: 'oauth',
          operation: 'token_endpoint',
          route: '/api/oauth/token',
        });
        logger.error('OAuth token endpoint failed');
      }
      return errorResponse(err);
    }
    const original =
      err instanceof Error
        ? err
        : new Error('Unexpected OAuth token endpoint failure', { cause: err });
    captureUnexpectedError(original, {
      feature: 'oauth',
      operation: 'token_endpoint',
      route: '/api/oauth/token',
    });
    logger.error('OAuth token endpoint failed');
    return errorResponse(
      new OAuthServerError('server_error', 'Unexpected error', 500, { cause: original }),
    );
  }
}

/**
 * form body の上限。
 *
 * grant 種別の判定に body が要るため、body 読み取りは per-grant の上限より手前にある
 * （粗い IP 上限の内側）。無制限に読ませると、その頻度差がそのまま memory / CPU の
 * 増幅になる。`/api/mcp` と同じく宣言値と実測値の両方で切る。
 */
const MAX_FORM_BODY_BYTES = 16 * 1024;

async function readFormBody(request: NextRequest): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    throw new OAuthServerError(
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded',
    );
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BODY_BYTES) {
    throw new OAuthServerError('invalid_request', 'Request body is too large');
  }

  const body = await request.text();
  // 宣言値は信用しない（欠落・過少申告どちらもありうる）。
  if (new TextEncoder().encode(body).length > MAX_FORM_BODY_BYTES) {
    throw new OAuthServerError('invalid_request', 'Request body is too large');
  }
  return new URLSearchParams(body);
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new OAuthServerError('invalid_request', `Missing required parameter: ${name}`);
  }
  return value;
}

function requiredResource(value: string | undefined) {
  const raw = required(value, 'resource');
  const resource = resolveRequestedResource(raw);
  if (!resource) {
    throw new OAuthServerError('invalid_target', 'The requested resource is not supported');
  }
  return resource;
}

function tokenResponse(body: unknown) {
  return NextResponse.json(body, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

function errorResponse(err: OAuthServerError) {
  return NextResponse.json(
    {
      error: err.code,
      error_description: err.httpStatus >= 500 ? 'OAuth server error' : err.message,
    },
    {
      status: err.httpStatus,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}

function writeFencedErrorResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Writes are temporarily paused for maintenance',
    },
    {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'retry-after': '30',
      },
    },
  );
}

function rateLimitErrorResponse(state: Exclude<OAuthTokenRateLimitState, 'allowed'>): NextResponse {
  const unavailable = state === 'unavailable';
  return NextResponse.json(
    {
      error: unavailable ? 'server_error' : 'temporarily_unavailable',
      error_description: unavailable ? 'OAuth server error' : 'Too many requests',
    },
    {
      status: unavailable ? 503 : 429,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'retry-after': unavailable ? '5' : '60',
      },
    },
  );
}
