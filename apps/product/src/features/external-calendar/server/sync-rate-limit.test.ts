import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_PRODUCTION_SUPABASE_REF,
  PRODUCT_VERCEL_PROJECT_ID,
} from '@/lib/dayopt-environment';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  fallbackLimit: vi.fn(),
  hashIdentifier: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const IDENTIFIER_HASH = 'a'.repeat(64);

function setIntegrationEnvironment(): void {
  vi.stubEnv('SUPABASE_RATE_LIMIT_POC_ENABLED', 'true');
  vi.stubEnv('DAYOPT_ENVIRONMENT', 'integration');
  vi.stubEnv('NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'integration');
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('VERCEL_TARGET_ENV', 'preview');
  vi.stubEnv('VERCEL_PROJECT_ID', PRODUCT_VERCEL_PROJECT_ID);
  vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'integration');
  vi.stubEnv('VERCEL_BRANCH_URL', PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length));
  vi.stubEnv('NEXT_PUBLIC_APP_URL', PRODUCT_INTEGRATION_APP_ORIGIN);
  vi.stubEnv(
    'NEXT_PUBLIC_SUPABASE_URL',
    'https://' + PRODUCT_INTEGRATION_SUPABASE_REF + '.supabase.co',
  );
}

function setProductionEnvironment(): void {
  vi.stubEnv('SUPABASE_RATE_LIMIT_POC_ENABLED', 'true');
  vi.stubEnv('DAYOPT_ENVIRONMENT', 'production');
  vi.stubEnv('NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'production');
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('VERCEL_TARGET_ENV', 'production');
  vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'main');
  vi.stubEnv(
    'NEXT_PUBLIC_SUPABASE_URL',
    'https://' + PRODUCT_PRODUCTION_SUPABASE_REF + '.supabase.co',
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('SUPABASE_RATE_LIMIT_POC_ENABLED', '');
  mocks.hashIdentifier.mockResolvedValue(IDENTIFIER_HASH);
  mocks.fallbackLimit.mockResolvedValue({ success: true });
  mocks.createServiceRoleClient.mockImplementation(() => ({ rpc: mocks.rpc }));
  vi.doMock('@/lib/rate-limit/upstash', () => ({
    calendarSyncNowRateLimit: { limit: mocks.fallbackLimit },
    hashRateLimitIdentifier: mocks.hashIdentifier,
  }));
  vi.doMock('@/lib/supabase/oauth', () => ({
    createServiceRoleClient: mocks.createServiceRoleClient,
  }));
});

afterEach(() => {
  vi.doUnmock('@/lib/rate-limit/upstash');
  vi.doUnmock('@/lib/supabase/oauth');
  vi.unstubAllEnvs();
});

describe('Calendar sync rate-limit backend selection', () => {
  it('uses the Supabase atomic RPC only on the fixed Integration deployment when explicitly enabled', async () => {
    setIntegrationEnvironment();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        remaining: 5,
        estimated_count: 1,
        reset_at: '2026-10-03T00:01:00.000Z',
        retry_after_seconds: 0,
      },
      error: null,
    });

    const rateLimit = await import('./sync-rate-limit');

    expect(rateLimit.isSupabaseCalendarSyncRateLimitPocEnabled()).toBe(true);
    await expect(rateLimit.checkCalendarSyncNowRateLimit(USER_ID)).resolves.toBe(true);
    expect(mocks.fallbackLimit).not.toHaveBeenCalled();
    expect(mocks.hashIdentifier).toHaveBeenCalledWith(USER_ID);
    expect(mocks.rpc).toHaveBeenCalledWith('check_supabase_rate_limit_poc', {
      p_scope: 'calendar-sync-now',
      p_identifier_hash: IDENTIFIER_HASH,
      p_limit_count: 6,
      p_window_seconds: 3600,
    });
  });

  it('returns denied when the atomic database budget is exhausted', async () => {
    setIntegrationEnvironment();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: false,
        remaining: 0,
        estimated_count: 6,
        reset_at: '2026-10-03T01:00:00.000Z',
        retry_after_seconds: 3600,
      },
      error: null,
    });

    const rateLimit = await import('./sync-rate-limit');

    await expect(rateLimit.checkCalendarSyncNowRateLimit(USER_ID)).resolves.toBe(false);
  });

  it('fails closed on Supabase errors without falling back to Upstash', async () => {
    setIntegrationEnvironment();
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('private database detail') });

    const rateLimit = await import('./sync-rate-limit');

    await expect(rateLimit.checkCalendarSyncNowRateLimit(USER_ID)).rejects.toThrow(
      'Supabase rate-limit service is unavailable',
    );
    expect(mocks.fallbackLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['Production with the flag accidentally set', setProductionEnvironment],
    [
      'ordinary Preview sharing the Integration database',
      () => {
        setIntegrationEnvironment();
        vi.stubEnv('DAYOPT_ENVIRONMENT', 'preview');
        vi.stubEnv('NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'preview');
        vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'codex/calendar-preview');
        vi.stubEnv('VERCEL_URL', 'product-git-codex-calendar-preview-dayopt.vercel.app');
        vi.stubEnv('VERCEL_BRANCH_URL', 'product-git-codex-calendar-preview-dayopt.vercel.app');
        vi.stubEnv(
          'NEXT_PUBLIC_APP_URL',
          'https://product-git-codex-calendar-preview-dayopt.vercel.app',
        );
      },
    ],
  ])('keeps %s on the existing Upstash path', async (_name, setEnvironment) => {
    setEnvironment();
    const rateLimit = await import('./sync-rate-limit');

    expect(rateLimit.isSupabaseCalendarSyncRateLimitPocEnabled()).toBe(false);
    await expect(rateLimit.checkCalendarSyncNowRateLimit(USER_ID)).resolves.toBe(true);
    expect(mocks.fallbackLimit).toHaveBeenCalledWith(USER_ID);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('keeps the existing disabled-limiter behavior when Upstash is not configured and the POC is off', async () => {
    const rateLimit = await import('./sync-rate-limit');

    await expect(rateLimit.checkCalendarSyncNowRateLimit(USER_ID)).resolves.toBe(true);
    expect(mocks.fallbackLimit).toHaveBeenCalledWith(USER_ID);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});
