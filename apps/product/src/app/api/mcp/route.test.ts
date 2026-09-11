import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthServerError } from '@/lib/oauth-server';

const verifyAccessToken = vi.hoisted(() => vi.fn());
const handleMcpProtocolRequest = vi.hoisted(() => vi.fn());
const checkMcpPreAuthRateLimit = vi.hoisted(() => vi.fn());
const checkMcpUserRateLimit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp')>()),
  verifyAccessToken,
}));
vi.mock('./_protocol-handler', () => ({ handleMcpProtocolRequest }));
vi.mock('@/lib/mcp/request-rate-limit', () => ({
  checkMcpPreAuthRateLimit,
  checkMcpUserRateLimit,
}));

import { POST } from './route';

const baseAuth = {
  tokenId: 'token-1',
  connectionId: 'connection-1',
  userId: 'user-1',
  clientId: 'chatgpt' as const,
  scopes: ['read:entries'] as const,
  proEntitled: true,
  resourceUri: 'https://mcp.dayopt.app' as const,
  expiresAt: 1_800_000_000,
};

function createRequest(
  body: unknown,
  authorization: string | null = 'Bearer opaque-token',
  url = 'https://mcp.dayopt.app/mcp',
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization) headers.set('authorization', authorization);
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function createRawRequest(body: string, additionalHeaders: HeadersInit = {}) {
  const headers = new Headers({
    authorization: 'Bearer opaque-token',
    'content-type': 'application/json',
    ...Object.fromEntries(new Headers(additionalHeaders)),
  });
  return new NextRequest('https://mcp.dayopt.app/mcp', {
    method: 'POST',
    headers,
    body,
  });
}

describe('MCP route scope preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkMcpPreAuthRateLimit.mockResolvedValue('allowed');
    verifyAccessToken.mockResolvedValue(baseAuth);
    checkMcpUserRateLimit.mockResolvedValue('allowed');
    handleMcpProtocolRequest.mockResolvedValue(
      Response.json({ jsonrpc: '2.0', result: {}, id: 1 }, { status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns HTTP 403 before a cached registered tool executes without its scope', async () => {
    verifyAccessToken.mockResolvedValue({ ...baseAuth, scopes: ['read:activities'] });
    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'plans.list', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:activities read:entries"',
    );
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.dayopt.app/.well-known/oauth-protected-resource"',
    );
    await expect(response.json()).resolves.toMatchObject({
      error: 'insufficient_scope',
      scope: 'read:activities read:entries',
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('read toolのstep-upはeffective scopeと不足scopeだけを要求する', async () => {
    verifyAccessToken.mockResolvedValue({ ...baseAuth, scopes: ['read:activities'] });

    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'constraints.get', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:activities read:constraints"',
    );
    expect(response.headers.get('www-authenticate')).not.toContain('read:entries');
    await expect(response.json()).resolves.toMatchObject({
      error: 'insufficient_scope',
      scope: 'read:activities read:constraints',
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('cached review.getはeffective scopeへread:statsだけを追加要求する', async () => {
    verifyAccessToken.mockResolvedValue({ ...baseAuth, scopes: ['read:constraints'] });

    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'review.get', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:constraints read:stats"',
    );
    expect(response.headers.get('www-authenticate')).not.toContain('read:entries');
    await expect(response.json()).resolves.toMatchObject({
      error: 'insufficient_scope',
      scope: 'read:constraints read:stats',
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('rejects JSON-RPC batch before executing any call', async () => {
    const response = await POST(
      createRequest([
        { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'records.list', arguments: {} },
          id: 2,
        },
      ]),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32600, message: 'JSON-RPC batch is not supported' },
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('content-lengthが1 MiBを超えるrequestをbody読取前に413で拒否する', async () => {
    const request = createRawRequest('{}');
    const getHeader = request.headers.get.bind(request.headers);
    vi.spyOn(request.headers, 'get').mockImplementation((name) =>
      name.toLowerCase() === 'content-length' ? String(1024 * 1024 + 1) : getHeader(name),
    );

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32000, message: 'Request body too large' },
    });
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(checkMcpUserRateLimit).not.toHaveBeenCalled();
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('content-lengthなしでも実bodyが1 MiBを超えれば413で拒否する', async () => {
    const response = await POST(createRawRequest(`"${'a'.repeat(1024 * 1024)}"`));

    expect(response.status).toBe(413);
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('content-lengthなしのstreamを1 MiB超過時点でcancelする', async () => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const requestInit = {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque-token',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
    } as const;
    const request = new NextRequest('https://mcp.dayopt.app/mcp', requestInit);

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pullCount).toBe(2);
    expect(cancelled).toBe(true);
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('multi-byte bodyをbyte数で測り1 MiB超過を413で拒否する', async () => {
    const response = await POST(createRawRequest(`"${'あ'.repeat(349_526)}"`));

    expect(response.status).toBe(413);
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('exactly 1 MiBの有効なJSON requestを受理する', async () => {
    const baseBody = {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
      padding: '',
    };
    const baseLength = new TextEncoder().encode(JSON.stringify(baseBody)).byteLength;
    const body = JSON.stringify({
      ...baseBody,
      padding: 'a'.repeat(1024 * 1024 - baseLength),
    });
    expect(new TextEncoder().encode(body).byteLength).toBe(1024 * 1024);

    const response = await POST(createRawRequest(body));

    expect(response.status).toBe(200);
    expect(handleMcpProtocolRequest).toHaveBeenCalledWith(
      expect.any(NextRequest),
      expect.objectContaining({
        parsedBody: expect.objectContaining({ method: 'tools/list' }),
      }),
    );
  });

  it('challenges a cached trash call with base read and the missing delete scope', async () => {
    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'plans.trash.list', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="read:entries delete:plans"');
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('challenges a cached mutation call with the complete read and write grant', async () => {
    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'plans.create', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="read:entries write:plans"');
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('passes a permitted call and the already parsed body to the SDK transport', async () => {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'plans.list', arguments: {} },
      id: 1,
    };

    const response = await POST(createRequest(body));

    expect(response.status).toBe(200);
    expect(handleMcpProtocolRequest).toHaveBeenCalledWith(
      expect.any(NextRequest),
      expect.objectContaining({
        parsedBody: body,
        authInfo: expect.objectContaining({
          token: '<redacted>',
          clientId: 'chatgpt',
          scopes: ['read:entries'],
          resource: new URL('https://mcp.dayopt.app'),
          extra: {
            tokenId: 'token-1',
            connectionId: 'connection-1',
            userId: 'user-1',
            resourceUri: 'https://mcp.dayopt.app',
          },
        }),
      }),
    );
    expect(checkMcpUserRateLimit).toHaveBeenCalledWith(baseAuth.userId);
    expect(checkMcpPreAuthRateLimit).toHaveBeenCalledWith(expect.any(NextRequest));
  });

  it('limits unauthenticated traffic before bearer token database verification', async () => {
    checkMcpPreAuthRateLimit.mockResolvedValueOnce('limited');

    const response = await POST(createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(checkMcpUserRateLimit).not.toHaveBeenCalled();
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it.each([
    'https://app.dayopt.app/api/mcp',
    'https://app.dayopt.app/api/mcp/',
    'https://preview-product.vercel.app/api/mcp/',
  ])(
    'rejects a direct inactive Product API host before rate limit or token lookup: %s',
    async (url) => {
      const response = await POST(
        createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }, 'Bearer opaque-token', url),
      );

      expect(response.status).toBe(404);
      expect(checkMcpPreAuthRateLimit).not.toHaveBeenCalled();
      expect(verifyAccessToken).not.toHaveBeenCalled();
    },
  );

  it('returns 429 without a bearer challenge when the authenticated user exceeds the limit', async () => {
    checkMcpUserRateLimit.mockResolvedValueOnce('limited');

    const response = await POST(createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Too many requests' },
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('rejects a Free user before parsing or dispatching any MCP operation', async () => {
    verifyAccessToken.mockResolvedValueOnce({ ...baseAuth, proEntitled: false });
    const requestInit = {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque-token',
        'content-type': 'application/json',
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"jsonrpc":"2.0","method":"tools/list","id":1}'),
          );
          controller.close();
        },
      }),
      duplex: 'half',
    } as const;
    const request = new NextRequest('https://mcp.dayopt.app/mcp', requestInit);
    const readBody = vi.spyOn(request.body!, 'getReader');

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        message: 'Open the Dayopt app to start your trial or subscribe to resume access',
      },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('returns retryable 503 without triggering reauthorization when rate limiting is unavailable', async () => {
    checkMcpUserRateLimit.mockResolvedValueOnce('unavailable');

    const response = await POST(createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Rate limit service unavailable' },
    });
    expect(handleMcpProtocolRequest).not.toHaveBeenCalled();
  });

  it('does not issue a scope challenge for an unregistered candidate tool name', async () => {
    handleMcpProtocolRequest.mockResolvedValueOnce(
      Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' },
          id: 1,
        },
        { status: 200 },
      ),
    );

    const response = await POST(
      createRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'plans.skip', arguments: {} },
        id: 1,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(handleMcpProtocolRequest).toHaveBeenCalledOnce();
  });

  it('returns a discovery challenge without an error when credentials are absent', async () => {
    const response = await POST(
      createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }, null),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // 初回 challenge は広告済み scope 一式。write を含めないと client は write を
    // 要求せず、gate を開いても書き込み権限が付かない（付与側は consent で降格する）
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:entries read:activities read:constraints read:stats write:plans delete:plans write:records delete:records"',
    );
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('www-authenticate')).not.toContain('error=');
    await expect(response.text()).resolves.toBe('');
  });

  it('Preview challengeは束縛されたbranch resource metadata URLだけを広告する', async () => {
    const previewOrigin = 'https://product-git-codex-mcp-preview-dayopt.vercel.app';
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'preview');
    vi.stubEnv('MCP_OAUTH_PREVIEW_BRANCH', 'codex/mcp-preview');
    vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', previewOrigin);
    vi.stubEnv('MCP_CANONICAL_RESOURCE_URI', previewOrigin);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_TARGET_ENV', 'preview');
    vi.stubEnv('VERCEL_BRANCH_URL', 'product-git-codex-mcp-preview-dayopt.vercel.app');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'codex/mcp-preview');

    const response = await POST(
      createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }, null, `${previewOrigin}/mcp`),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${previewOrigin}/.well-known/oauth-protected-resource"`,
    );
    expect(response.headers.get('www-authenticate')).not.toContain(
      'resource_metadata="https://mcp.dayopt.app/',
    );
  });

  it('MCP identityが不整合な環境ではtoken検証前に503へ縮退する', async () => {
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'preview');

    const response = await POST(
      createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }, null),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('returns invalid_token for expired or revoked bearer credentials', async () => {
    verifyAccessToken.mockRejectedValueOnce(
      new OAuthServerError('invalid_token', 'OAuth connection is no longer authorized', 401),
    );

    const response = await POST(createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    // 3 経路ある challenge のうちこの経路だけ scope が未固定だった。再認可で
    // 広告済み 8 scope へ広がる契約を discovery 経路と同じ exact 文字列で守る
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:entries read:activities read:constraints read:stats write:plans delete:plans write:records delete:records"',
    );
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_token',
      error_description: 'Access token is invalid or expired',
    });
  });

  it('returns an invalid_request challenge for a malformed bearer value', async () => {
    const response = await POST(
      createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }, 'Bearer token,second'),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toContain('Bearer error="invalid_request"');
    expect(response.headers.get('www-authenticate')).toContain(
      'scope="read:entries read:activities read:constraints read:stats write:plans delete:plans write:records delete:records"',
    );
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Authorization header must be "Bearer <token>"',
    });
  });

  it('returns a retryable 503 when token authorization dependencies fail', async () => {
    verifyAccessToken.mockRejectedValueOnce(
      new OAuthServerError('server_error', 'Access token verification failed', 503),
    );

    const response = await POST(createRequest({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: 'server_error',
      error_description: 'Authentication service unavailable',
    });
  });
});
