import { NextResponse, type NextRequest } from 'next/server';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { logger } from '@/lib/logger';
import { extractBearerToken, verifyAccessToken } from '@/lib/mcp';
import {
  checkMcpPreAuthRateLimit,
  checkMcpUserRateLimit,
  type McpRateLimitState,
} from '@/lib/mcp/request-rate-limit';
import { ADVERTISED_SCOPES, OAuthServerError, type SupportedScope } from '@/lib/oauth-server';
import { getOAuthEnvironmentConfig } from '@/lib/oauth-server/identity-env';
import { rejectUnexpectedOAuthHost } from '@/lib/oauth-server/request-host';
import { captureUnexpectedError } from '@/lib/sentry';

import { handleMcpProtocolRequest } from './_protocol-handler';
import { getRequiredScopeForTool, mergeMcpChallengeScopes } from './_tools/registry';

/**
 * MCP Streamable HTTP endpoint.
 *
 * Bearer token を `oauth_tokens` で検証 → per-request stateless transport を立て、
 * MCP server に dispatch する。
 *
 * Vercel rewrite で MCP host の `/` から到達する (production)。
 * `/mcp` も既存 client 向けの互換 alias として同じ handler に到達する。
 * 401 のときは `WWW-Authenticate` の `resource_metadata` で client が
 * `/.well-known/oauth-protected-resource` を辿れるようにする (MCP spec 2025-03)。
 */

export const dynamic = 'force-dynamic';
/**
 * 認証だけで逐次 5 問い合わせ（identity RPC → token → connection → write gate →
 * profile）。`lib/mcp/access-db.ts` の 15 秒 × 5 = 75 秒あるので、段の 60 では
 * **認証を通り切る前に kill されて handler の 503 すら返せない**。tool dispatch の
 * 分も乗るため 120 にする。
 *
 * 上の callback（#1990）と違い one-time grant は消費しないので失敗は再試行可能だが、
 * 全 tool 呼び出しが 504 になる点は同じく避けたい。dispatch 数自体に上限は無いので、
 * 120 も「全依存同時ハング時の完走保証」ではない（infra.md §Function 実行時間の上限）。
 */
export const maxDuration = 120;

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function DELETE(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest): Promise<Response> {
  const hostRejection = rejectUnexpectedOAuthHost(request);
  if (hostRejection) return hostRejection;

  const preAuthRateLimitState = await checkMcpPreAuthRateLimit(request);
  if (preAuthRateLimitState !== 'allowed') return rateLimitErrorResponse(preAuthRateLimitState);

  const declaredBodyRejection = rejectDeclaredOversizeBody(request);
  if (declaredBodyRejection) return declaredBodyRejection;

  let auth;
  try {
    const token = extractBearerToken(request.headers.get('authorization'));
    auth = await verifyAccessToken(token);
  } catch (err) {
    return authErrorResponse(err);
  }

  const rateLimitState = await checkMcpUserRateLimit(auth.userId);
  if (rateLimitState !== 'allowed') return rateLimitErrorResponse(rateLimitState);

  if (!auth.proEntitled) return proEntitlementErrorResponse();

  const parsedRequest = await parseMcpRequestBody(request);
  if (!parsedRequest.ok) return parsedRequest.response;

  const missingScopes = collectMissingToolScopes(parsedRequest.body, auth.scopes);
  if (missingScopes.length > 0) {
    return insufficientScopeResponse(auth.scopes, missingScopes);
  }

  try {
    const authInfo: AuthInfo = {
      token: '<redacted>',
      clientId: auth.clientId,
      scopes: auth.scopes,
      expiresAt: auth.expiresAt,
      resource: new URL(auth.resourceUri),
      extra: {
        userId: auth.userId,
        tokenId: auth.tokenId,
        connectionId: auth.connectionId,
        resourceUri: auth.resourceUri,
      },
    };
    return await handleMcpProtocolRequest(request, {
      ...(parsedRequest.body === undefined ? {} : { parsedBody: parsedRequest.body }),
      authInfo,
    });
  } catch (err) {
    const original =
      err instanceof Error ? err : new Error('Unexpected MCP transport failure', { cause: err });
    captureUnexpectedError(original, {
      feature: 'mcp',
      operation: 'handle_transport_request',
      route: '/api/mcp',
    });
    logger.error('MCP transport request failed');
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
      { status: 500 },
    );
  }
}

type ParsedMcpRequest = { ok: true; body: unknown | undefined } | { ok: false; response: Response };

async function parseMcpRequestBody(request: NextRequest): Promise<ParsedMcpRequest> {
  if (request.method !== 'POST') return { ok: true, body: undefined };

  const bodyText = await readLimitedRequestBody(request);
  if (bodyText === null) {
    return { ok: false, response: mcpRequestErrorResponse(413, -32000, 'Request body too large') };
  }

  try {
    const body = JSON.parse(bodyText) as unknown;
    if (Array.isArray(body)) {
      return {
        ok: false,
        response: mcpRequestErrorResponse(400, -32600, 'JSON-RPC batch is not supported'),
      };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, response: mcpRequestErrorResponse(400, -32700, 'Parse error') };
  }
}

function rejectDeclaredOversizeBody(request: NextRequest): Response | null {
  if (request.method !== 'POST') return null;
  const contentLength = Number(request.headers.get('content-length'));
  return Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES
    ? mcpRequestErrorResponse(413, -32000, 'Request body too large')
    : null;
}

async function readLimitedRequestBody(request: NextRequest): Promise<string | null> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bodyBytes);
}

function collectMissingToolScopes(
  body: unknown,
  grantedScopes: readonly SupportedScope[],
): SupportedScope[] {
  const missing = new Set<SupportedScope>();

  if (!isRecord(body) || body.method !== 'tools/call' || !isRecord(body.params)) return [];
  const toolName = body.params.name;
  if (typeof toolName !== 'string') return [];
  const requiredScope = getRequiredScopeForTool(toolName);
  if (requiredScope && !grantedScopes.includes(requiredScope)) missing.add(requiredScope);

  return [...missing];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function insufficientScopeResponse(
  effectiveScopes: readonly SupportedScope[],
  missingScopes: readonly SupportedScope[],
): Response {
  const requiredScopes = mergeMcpChallengeScopes(effectiveScopes, missingScopes);
  const required = requiredScopes.join(' ');
  return NextResponse.json(
    {
      error: 'insufficient_scope',
      error_description: 'Additional authorization is required',
      scope: required,
    },
    {
      status: 403,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate':
          `Bearer error="insufficient_scope", scope="${required}", ` +
          `resource_metadata="${getResourceMetadataUrl()}"`,
      },
    },
  );
}

function mcpRequestErrorResponse(status: number, code: number, message: string): Response {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function rateLimitErrorResponse(state: Exclude<McpRateLimitState, 'allowed'>): Response {
  const unavailable = state === 'unavailable';
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: unavailable ? 'Rate limit service unavailable' : 'Too many requests',
      },
      id: null,
    },
    {
      status: unavailable ? 503 : 429,
      headers: {
        'cache-control': 'no-store',
        'retry-after': unavailable ? '5' : '60',
      },
    },
  );
}

function proEntitlementErrorResponse(): Response {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Open the Dayopt app to start your trial or subscribe to resume access',
      },
      id: null,
    },
    {
      status: 403,
      headers: {
        'cache-control': 'no-store',
      },
    },
  );
}

function authErrorResponse(err: unknown): Response {
  const isOAuthErr = err instanceof OAuthServerError;
  // OAuthServerError は err.httpStatus を尊重 (auth failure=401 / dependency failure=503)。
  // 5xx を 401 に丸めると client が再認証ループに入って真の障害が観測できない。
  const status = isOAuthErr ? err.httpStatus : 500;
  if (status >= 500) {
    const original =
      isOAuthErr && err.cause instanceof Error
        ? err.cause
        : err instanceof Error
          ? err
          : new Error('Unexpected MCP authentication failure', { cause: err });
    captureUnexpectedError(original, {
      feature: 'mcp',
      operation: 'authenticate_request',
      route: '/api/mcp',
    });
    logger.error('MCP request authentication failed');
  }

  // 401 discovery/invalid token と 400 invalid_request はBearer challengeを返す。
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (status === 401 || (status === 400 && isOAuthErr && err.code === 'invalid_request')) {
    const challengeParameters = [
      ...(isOAuthErr && err.code === 'invalid_token' ? ['error="invalid_token"'] : []),
      ...(isOAuthErr && err.code === 'invalid_request' && status === 400
        ? ['error="invalid_request"']
        : []),
      // 初回認可 (pre-auth challenge) では広告済み scope 一式を要求する。
      // token の granted scopes に無い tool は tools/list に出ないため、ここを
      // read:entries だけにすると activities/review/constraints が初回接続で不可視になる
      // (発見できない tool は step-up も発火しない)。write 系も同じ理由で含める:
      // 要求されない限り付与されず、gate が閉じている client では consent 側の
      // resolveGrantableScopes が read へ降格させる。
      `scope="${ADVERTISED_SCOPES.join(' ')}"`,
      `resource_metadata="${getResourceMetadataUrl()}"`,
    ];
    headers['www-authenticate'] = `Bearer ${challengeParameters.join(', ')}`;
  }
  if (status === 503) {
    headers['retry-after'] = '5';
  }

  // RFC 6750 §3.1: credentialなし / unsupported auth scheme の401では、
  // discovery challenge以外のerror情報を返さない。
  if (status === 401 && isOAuthErr && err.code === 'invalid_request') {
    return new Response(null, { status, headers });
  }

  headers['content-type'] = 'application/json';

  return new Response(
    JSON.stringify({
      error: isOAuthErr ? err.code : 'server_error',
      error_description:
        isOAuthErr && err.code === 'invalid_token'
          ? 'Access token is invalid or expired'
          : isOAuthErr && status < 500
            ? err.message
            : 'Authentication service unavailable',
    }),
    {
      status,
      headers,
    },
  );
}

function getResourceMetadataUrl(): string {
  return getOAuthEnvironmentConfig().protectedResourceMetadataUri;
}
