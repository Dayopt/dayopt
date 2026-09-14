/** #2721 V-6 / V-8: real Supabase SDK and tRPC adapter, captured outbound fetch. */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://boundary.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    SUPABASE_SECRET_KEY: 'test-admin',
  },
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: vi.fn(),
  observeAuthOperation: (_name: string, call: () => PromiseLike<unknown>) => call(),
}));
vi.mock('@/lib/rate-limit/upstash', () => ({
  trpcPreAuthIpRateLimit: null,
  trpcUserRateLimit: null,
}));
vi.mock('@/lib/mcp/auth', () => ({ extractBearerToken: vi.fn(), verifyAccessToken: vi.fn() }));

import { createFetchTRPCContext } from './context';
import { createTRPCRouter, protectedProcedure } from './procedures';

const reached = vi.fn(() => 'protected-result');
const router = createTRPCRouter({ probe: protectedProcedure.query(reached) });
const user = {
  id: 'c4f31a49-e8bf-4382-a42d-7f6284ba6cd0',
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  factors: [],
};

function session(expiresAt: number) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: expiresAt, aal: 'aal1' })}.c2ln`,
    refresh_token: 'test-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user,
  };
}
function request(value?: object, headers: Record<string, string> = {}) {
  if (value)
    headers.cookie = `sb-boundary-auth-token=base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  return new Request('https://app.dayopt.app/api/trpc/probe', { headers });
}
async function context(req: Request) {
  return createFetchTRPCContext({ req, resHeaders: new Headers(), info: {} } as never);
}

beforeEach(() => {
  reached.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public HTTP authentication boundary', () => {
  it.each([undefined, { invalid: true }])(
    'missing/structurally invalid session performs no auth fetch (%j)',
    async (value) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      expect((await context(request(value))).userId).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('well-shaped but invalid token makes one auth request and never authenticates', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: 'invalid token' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      (await context(request(session(Math.floor(Date.now() / 1000) + 3600)))).userId,
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/v1/user');
  });
  it('valid session verifies user and MFA through two real SDK requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(user));
    vi.stubGlobal('fetch', fetchMock);
    expect((await context(request(session(Math.floor(Date.now() / 1000) + 3600)))).userId).toBe(
      user.id,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/auth/v1/user',
      '/auth/v1/user',
    ]);
  });
  it('expired session refreshes before user and MFA verification', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          String(url).includes('/token?') ? session(Math.floor(Date.now() / 1000) + 3600) : user,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect((await context(request(session(Math.floor(Date.now() / 1000) - 60)))).userId).toBe(
      user.id,
    );
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/auth/v1/token',
      '/auth/v1/user',
      '/auth/v1/user',
    ]);
  });
  it.each([undefined, 'wrong-admin', 'test-admin'])(
    'API key %s cannot reach a protected procedure',
    async (apiKey) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      const req = request(undefined, apiKey ? { 'x-api-key': apiKey } : {});
      const result = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router,
        createContext: createFetchTRPCContext,
      });
      expect(result.status).toBe(401);
      expect(reached).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
