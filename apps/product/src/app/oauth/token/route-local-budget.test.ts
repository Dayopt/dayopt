/** V-7: localの実bucketをHTTP handlerから使い、現行の境界を数える。 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createServiceRoleClient = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('This budget fixture must not access a database');
  }),
);
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('VERCEL_TARGET_ENV', 'development');
  vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'production');
  vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request(refreshToken: string, ip = '203.0.113.10') {
  return new NextRequest('http://localhost:3000/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': ip },
    // client_idを省略することで、bucket通過後はDBを呼ばずinvalid_requestになる。
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
}

describe('refresh HTTP budget boundaries without Redis', () => {
  it('same token: first 30 reach validation, including the 11th; 31st is 429', async () => {
    const { POST } = await import('./route');
    for (let i = 0; i < 30; i++) expect((await POST(request('same-token'))).status).toBe(400);
    const limited = await POST(request('same-token'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('token-denied traffic consumes IP budget without consuming the global budget', async () => {
    const { POST } = await import('./route');
    for (let i = 0; i < 120; i++) {
      expect((await POST(request('same-token'))).status).toBe(i < 30 ? 400 : 429);
    }
    // tokenを変えても同一IPは拒否。他IPは通るのでglobal超過による偽陽性ではない。
    expect((await POST(request('fresh-token'))).status).toBe(429);
    expect((await POST(request('fresh-token', '203.0.113.11'))).status).toBe(400);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('changing IP and token still reaches the shared 120/global budget', async () => {
    const { POST } = await import('./route');
    for (let i = 0; i < 120; i++) {
      expect((await POST(request('token-' + i, '203.0.113.' + (i + 1)))).status).toBe(400);
    }
    expect((await POST(request('token-120', '203.0.113.121'))).status).toBe(429);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
