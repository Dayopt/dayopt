import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), createServiceRoleClient: vi.fn() }));
vi.mock('@/lib/rate-limit/upstash', () => ({ calendarSyncNowRateLimit: { limit: mocks.limit } }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: mocks.createServiceRoleClient }));

import { checkCalendarSyncNowRateLimit } from './sync-rate-limit';

describe('Calendar sync POC retirement', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SUPABASE_RATE_LIMIT_POC_ENABLED', 'true');
    mocks.limit.mockResolvedValue({ success: true });
  });

  it('uses the existing Upstash limiter even if a legacy POC flag remains enabled', async () => {
    await expect(checkCalendarSyncNowRateLimit('synthetic-user')).resolves.toBe(true);
    expect(mocks.limit).toHaveBeenCalledExactlyOnceWith('synthetic-user');
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('keeps a denied rate-limit result denied', async () => {
    mocks.limit.mockResolvedValue({ success: false });
    await expect(checkCalendarSyncNowRateLimit('synthetic-user')).resolves.toBe(false);
    expect(mocks.limit).toHaveBeenCalledExactlyOnceWith('synthetic-user');
  });

  it('propagates a backend failure to the fail-closed router', async () => {
    mocks.limit.mockRejectedValue(new Error('backend unavailable'));
    await expect(checkCalendarSyncNowRateLimit('synthetic-user')).rejects.toThrow(
      'backend unavailable',
    );
    expect(mocks.limit).toHaveBeenCalledExactlyOnceWith('synthetic-user');
  });
});
