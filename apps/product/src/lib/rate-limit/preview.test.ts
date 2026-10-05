import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRODUCT_VERCEL_PROJECT_ID } from '@/lib/dayopt-environment';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {
      redisConstructor();
    }
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError: vi.fn() }));

function previewEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const values = {
    NODE_ENV: 'production',
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
    VERCEL_GIT_COMMIT_REF: 'codex/example',
    DAYOPT_ENVIRONMENT: 'preview',
    NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'preview',
    NEXT_PUBLIC_APP_URL: 'https://product-example-dayopt.vercel.app',
    VERCEL_URL: 'product-example-dayopt.vercel.app',
    NEXT_PUBLIC_SUPABASE_URL: 'https://tilwaprottpyhlfoggbb.supabase.co',
    MCP_OAUTH_ENVIRONMENT: '',
    MCP_OAUTH_PREVIEW_BRANCH: '',
    MCP_OAUTH_PREVIEW_UPSTASH_HOST: '',
    OAUTH_AUTHORIZATION_SERVER_URI: '',
    MCP_CANONICAL_RESOURCE_URI: '',
    UPSTASH_REDIS_REST_URL: 'https://inherited-example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'safe-dummy-token',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value ?? '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ordinary Preview rate limits', () => {
  it.each(['tilwaprottpyhlfoggbb', 'abcdefghijklmnopqrst'])(
    'never constructs Redis for %s, including inherited/malformed/partial credentials',
    async (ref) => {
      for (const credentials of [
        {},
        { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
        { UPSTASH_REDIS_REST_URL: 'malformed' },
        { UPSTASH_REDIS_REST_TOKEN: '' },
      ]) {
        previewEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, ...credentials });
        const rateLimits = await import('./upstash');
        expect(rateLimits.isUpstashEnabled).toBe(false);
        expect(rateLimits.reauthRateLimit).not.toBeNull();
        expect(redisConstructor).not.toHaveBeenCalled();
      }
    },
  );

  it('enforces budgets, isolates users and contexts, and resets at the window boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    previewEnv({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
    const { reauthRateLimit, withUpstashRateLimit, icalFeedRateLimit } = await import('./upstash');
    for (let i = 0; i < 5; i++)
      expect((await reauthRateLimit!.limit('delete:user-a')).success).toBe(true);
    expect((await reauthRateLimit!.limit('delete:user-a')).success).toBe(false);
    expect((await reauthRateLimit!.limit('email:user-a')).success).toBe(true);
    expect((await reauthRateLimit!.limit('delete:user-b')).success).toBe(true);
    const request = new Request('https://example.com', { headers: { 'x-real-ip': '203.0.113.1' } });
    for (let i = 0; i < 10; i++)
      expect((await withUpstashRateLimit(request, icalFeedRateLimit)).state).toBe('checked');
    expect(await withUpstashRateLimit(request, icalFeedRateLimit)).toMatchObject({
      state: 'checked',
      success: false,
      limit: 10,
      remaining: 0,
    });
    vi.advanceTimersByTime(600_000);
    expect(await reauthRateLimit!.limit('delete:user-a')).toMatchObject({
      success: true,
      remaining: 4,
      reset: 1_201_000,
    });
  });
});

it.each([
  { VERCEL_ENV: 'production' },
  { VERCEL_TARGET_ENV: 'production' },
  { VERCEL_GIT_COMMIT_REF: 'integration' },
  { DAYOPT_ENVIRONMENT: 'integration' },
  { NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration' },
  { MCP_OAUTH_ENVIRONMENT: 'preview' },
  { MCP_OAUTH_ENVIRONMENT: 'integration' },
  { MCP_OAUTH_ENVIRONMENT: 'production' },
  { MCP_OAUTH_PREVIEW_BRANCH: 'codex/example' },
  { OAUTH_AUTHORIZATION_SERVER_URI: 'https://product-example-dayopt.vercel.app' },
  { MCP_CANONICAL_RESOURCE_URI: 'https://product-example-dayopt.vercel.app/api/mcp' },
  { VERCEL_PROJECT_ID: 'unknown-project' },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co' },
  { NEXT_PUBLIC_SUPABASE_URL: 'malformed' },
  { DAYOPT_ENVIRONMENT: 'unknown' },
])('never grants local exemption to excluded identity %j', async (overrides) => {
  previewEnv({ ...overrides, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
  const { reauthRateLimit } = await import('./upstash');
  expect(reauthRateLimit).toBeNull();
});

it('ordinary Preview does not acquire OAuth surface authority', async () => {
  previewEnv();
  const { resolveOAuthEnvironmentFromEnv } = await import('@/lib/oauth-server/identity');
  expect(resolveOAuthEnvironmentFromEnv(process.env).surfacesEnabled).toBe(false);
});

it('preserves all exported budgets without network calls', async () => {
  previewEnv();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const rateLimits = await import('./upstash');
  const budgets = [
    [rateLimits.contactRateLimit, 5, 3_600_000],
    [rateLimits.contactGlobalRateLimit, 60, 3_600_000],
    [rateLimits.trpcUserRateLimit, 300, 60_000],
    [rateLimits.reauthRateLimit, 5, 600_000],
    [rateLimits.mcpPreAuthRateLimit, 1200, 60_000],
    [rateLimits.mcpUserRateLimit, 120, 60_000],
    [rateLimits.oauthTokenIpRateLimit, 10, 60_000],
    [rateLimits.oauthTokenPreBodyIpRateLimit, 600, 60_000],
    [rateLimits.oauthTokenRefreshRateLimit, 30, 60_000],
    [rateLimits.oauthTokenRefreshIpRateLimit, 120, 60_000],
    [rateLimits.oauthTokenClientRateLimit, 120, 60_000],
    [rateLimits.timeblockCreateRateLimit, 500, 86_400_000],
    [rateLimits.icalFeedRateLimit, 10, 60_000],
    [rateLimits.icalFeedIpRateLimit, 60, 60_000],
    [rateLimits.trpcPreAuthIpRateLimit, 600, 60_000],
    [rateLimits.healthCheckGlobalRateLimit, 120, 60_000],
    [rateLimits.cronHeartbeatHealthRateLimit, 30, 60_000],
    [rateLimits.icalFeedGlobalRateLimit, 600, 60_000],
    [rateLimits.calendarConnectRateLimit, 10, 3_600_000],
    [rateLimits.calendarSyncNowRateLimit, 6, 3_600_000],
    [rateLimits.cspReportRateLimit, 20, 60_000],
    [rateLimits.cspReportGlobalRateLimit, 120, 60_000],
  ] as const;
  try {
    for (const [limiter, limit, windowMs] of budgets) {
      expect(await limiter!.limit('same-user')).toMatchObject({
        success: true,
        limit,
        remaining: limit - 1,
        reset: 1_000 + windowMs,
      });
    }
    expect(redisConstructor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
