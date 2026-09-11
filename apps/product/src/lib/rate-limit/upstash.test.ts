import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureUnexpectedError: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError, warn: vi.fn() },
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: mocks.captureUnexpectedError,
}));

import {
  claimResendWebhookEvent,
  completeResendWebhookEvent,
  contactGlobalRateLimit,
  contactRateLimit,
  cspReportGlobalRateLimit,
  cspReportRateLimit,
  hashRateLimitIdentifier,
  isUpstashEnabled,
  mcpPreAuthRateLimit,
  mcpUserRateLimit,
  oauthTokenGlobalRateLimit,
  oauthTokenIpRateLimit,
  RATE_LIMIT_PRESETS,
  RATE_LIMIT_TIMEOUT_MS,
  RateLimitUnavailableError,
  reauthRateLimit,
  releaseResendWebhookEvent,
  requireAvailableRateLimitResult,
  RESEND_WEBHOOK_PROCESSED_SECONDS,
  timeblockCreateRateLimit,
  trpcUserRateLimit,
  UPSTASH_COST_ESTIMATE,
  withUpstashRateLimit,
} from './upstash';

const allowedResult = {
  success: true,
  limit: 5,
  remaining: 4,
  reset: 10_000,
  pending: Promise.resolve(),
  reason: undefined,
};

describe('Upstash Rate Limit', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('@upstash/ratelimit');
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@/env');
    vi.unstubAllEnvs();
  });

  it('keeps local/test limiters disabled when credentials are absent', () => {
    expect(isUpstashEnabled).toBe(false);
    expect(contactRateLimit).toBeNull();
    expect(contactGlobalRateLimit).toBeNull();
    expect(trpcUserRateLimit).toBeNull();
    expect(reauthRateLimit).toBeNull();
    expect(mcpPreAuthRateLimit).toBeNull();
    expect(mcpUserRateLimit).toBeNull();
    expect(oauthTokenIpRateLimit).toBeNull();
    expect(oauthTokenGlobalRateLimit).toBeNull();
    expect(timeblockCreateRateLimit).toBeNull();
    expect(cspReportRateLimit).toBeNull();
    expect(cspReportGlobalRateLimit).toBeNull();
  });

  it('hashes identifiers deterministically without retaining raw IP, email, or user IDs', async () => {
    const rawIdentifier = 'ip:203.0.113.10';
    const first = await hashRateLimitIdentifier(rawIdentifier);
    const second = await hashRateLimitIdentifier(rawIdentifier);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain(rawIdentifier);
    expect(await hashRateLimitIdentifier('user-123')).not.toBe(first);
    const emailHash = await hashRateLimitIdentifier('email:person@example.com');
    expect(emailHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(emailHash).not.toContain('person@example.com');
    expect(emailHash).not.toBe(first);
  });

  it('converts the SDK fail-open timeout result into backend unavailable', () => {
    expect(() =>
      requireAvailableRateLimitResult({ ...allowedResult, reason: 'timeout' } as never),
    ).toThrow(RateLimitUnavailableError);
    expect(requireAvailableRateLimitResult(allowedResult as never)).toBe(allowedResult);
  });

  it('uses local webhook leases outside Production and fails closed without Redis in Production', async () => {
    const claim = await claimResendWebhookEvent('event-1');
    expect(claim).toMatchObject({ status: 'claimed' });
    if (claim.status !== 'claimed') throw new Error('Expected a local claim');
    await expect(completeResendWebhookEvent('event-1', claim.token)).resolves.toBeUndefined();
    await expect(releaseResendWebhookEvent('event-1', claim.token)).resolves.toBeUndefined();

    vi.stubEnv('VERCEL_ENV', 'production');
    await expect(claimResendWebhookEvent('event-2')).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
  });

  it('distinguishes disabled, checked, and unavailable checks and captures the original error once', async () => {
    const request = new Request('https://app.dayopt.app/api/csp-report', {
      headers: { 'x-real-ip': '203.0.113.10' },
    });
    await expect(withUpstashRateLimit(request, null)).resolves.toEqual({ state: 'disabled' });

    const allowedLimiter = { limit: vi.fn().mockResolvedValue(allowedResult) };
    await expect(withUpstashRateLimit(request, allowedLimiter)).resolves.toEqual({
      state: 'checked',
      success: true,
      limit: 5,
      remaining: 4,
      reset: 10_000,
      pending: allowedResult.pending,
    });

    const backendError = new Error('redis unavailable');
    const unavailableLimiter = { limit: vi.fn().mockRejectedValue(backendError) };
    await expect(withUpstashRateLimit(request, unavailableLimiter)).resolves.toEqual({
      state: 'unavailable',
    });
    expect(mocks.captureUnexpectedError).toHaveBeenCalledOnce();
    expect(mocks.captureUnexpectedError).toHaveBeenCalledWith(backendError, {
      feature: 'rate_limit',
      operation: 'upstash_rate_limit_check',
      source: 'upstash',
    });
  });

  it('uses only the Vercel platform IP and ignores spoofed forwarded chains', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue(allowedResult) };
    const firstRequest = new Request('https://app.dayopt.app/api/csp-report', {
      headers: {
        'x-real-ip': '203.0.113.10',
        'x-forwarded-for': '198.51.100.1',
      },
    });
    const secondRequest = new Request('https://app.dayopt.app/api/csp-report', {
      headers: {
        'x-real-ip': '203.0.113.10',
        'x-forwarded-for': '192.0.2.55',
      },
    });

    await withUpstashRateLimit(firstRequest, limiter);
    await withUpstashRateLimit(secondRequest, limiter);

    expect(limiter.limit).toHaveBeenNthCalledWith(1, 'ip:203.0.113.10');
    expect(limiter.limit).toHaveBeenNthCalledWith(2, 'ip:203.0.113.10');
  });

  it('uses one shared unknown bucket when the platform IP is missing or invalid', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue(allowedResult) };
    const forwardedOnly = new Request('https://app.dayopt.app/api/csp-report', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    const invalidPlatformIp = new Request('https://app.dayopt.app/api/csp-report', {
      headers: {
        'x-real-ip': 'invalid',
        'x-forwarded-for': '198.51.100.20',
      },
    });

    await withUpstashRateLimit(forwardedOnly, limiter);
    await withUpstashRateLimit(invalidPlatformIp, limiter);

    expect(limiter.limit).toHaveBeenNthCalledWith(1, 'ip:unknown');
    expect(limiter.limit).toHaveBeenNthCalledWith(2, 'ip:unknown');
  });

  it('constructs every enabled limiter with no analytics, a 2 second timeout, and hashed keys', async () => {
    vi.resetModules();
    const constructorOptions: Array<Record<string, unknown>> = [];
    const limit = vi.fn().mockResolvedValue(allowedResult);

    class MockRatelimit {
      static slidingWindow(requests: number, window: string) {
        return { requests, window };
      }

      constructor(options: Record<string, unknown>) {
        constructorOptions.push(options);
      }

      limit = limit;
    }

    vi.doMock('@upstash/ratelimit', () => ({ Ratelimit: MockRatelimit }));
    vi.doMock('@upstash/redis', () => ({ Redis: class MockRedis {} }));
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'configured');

    const enabledModule = await import('./upstash');
    // #2024 で reauthRateLimit を追加（15 → 16）
    expect(constructorOptions).toHaveLength(16);
    for (const options of constructorOptions) {
      expect(options.analytics).toBe(false);
      expect(options.timeout).toBe(RATE_LIMIT_TIMEOUT_MS);
      expect(options.prefix).toMatch(/^ratelimit:product:/u);
    }

    await enabledModule.contactRateLimit?.limit('ip:203.0.113.10');
    const persistedIpIdentifier = limit.mock.calls.at(-1)?.[0];
    expect(persistedIpIdentifier).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedIpIdentifier).not.toContain('203.0.113.10');

    await enabledModule.contactRateLimit?.limit('email:person@example.com');
    const persistedEmailIdentifier = limit.mock.calls.at(-1)?.[0];
    expect(persistedEmailIdentifier).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedEmailIdentifier).not.toContain('person@example.com');
    expect(persistedEmailIdentifier).not.toBe(persistedIpIdentifier);
  });

  it('#2011: loads without touching @/env even when its schema validation would throw', async () => {
    // generic Preview deployment は SUPABASE_SECRET_KEY を持たない
    // （決定ログ（削除済み、git 履歴参照））ため、`@/env` の
    // Proxy に触れると schema 全体の検証が走り無関係に throw する。この module は
    // Upstash の2変数しか要らないので `@/env` を経由しないことを固定する。
    vi.resetModules();
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: class MockRatelimit {
        static slidingWindow(requests: number, window: string) {
          return { requests, window };
        }
        limit = vi.fn().mockResolvedValue(allowedResult);
      },
    }));
    vi.doMock('@upstash/redis', () => ({ Redis: class MockRedis {} }));
    vi.doMock('@/env', () => ({
      env: new Proxy(
        {},
        {
          get() {
            throw new Error(
              '#2011 regression: @/env should not be touched by lib/rate-limit/upstash.ts',
            );
          },
        },
      ),
    }));
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'configured');

    const enabledModule = await import('./upstash');

    expect(enabledModule.isUpstashEnabled).toBe(true);
    expect(enabledModule.cspReportRateLimit).not.toBeNull();
  });

  it('keeps documented presets and cost constants stable', () => {
    expect(RATE_LIMIT_PRESETS.api.requests).toBe(60);
    expect(RATE_LIMIT_PRESETS.auth.requests).toBe(5);
    expect(RATE_LIMIT_PRESETS.passwordReset.requests).toBe(3);
    expect(RATE_LIMIT_PRESETS.search.requests).toBe(30);
    expect(RATE_LIMIT_PRESETS.upload.requests).toBe(10);
    expect(UPSTASH_COST_ESTIMATE.estimatedMonthlyCost).toBe(6);
    expect(RESEND_WEBHOOK_PROCESSED_SECONDS).toBe(35 * 24 * 60 * 60);
  });
});
