import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({ rpc }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

import { createSignupAnalyticsClaim } from '@/lib/analytics/signup-analytics-claim';
import { SignupAnalyticsClaimService } from './signup-analytics-claim-service';

const USER_ID = '09f71067-0838-4e9f-a05d-d729bc876281';

describe('SignupAnalyticsClaimService', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'server-only-secret');
    vi.clearAllMocks();
  });

  it('rejects a forged marker before calling the database', async () => {
    const service = new SignupAnalyticsClaimService();

    await expect(service.claim(USER_ID, 'registered=email')).resolves.toEqual({
      status: 'invalid',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('claims a valid marker once for the authenticated account', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: true, error: null });
    rpc.mockReturnValueOnce({ abortSignal });
    const token = createSignupAnalyticsClaim(USER_ID, 'email') ?? '';
    const service = new SignupAnalyticsClaimService();

    await expect(service.claim(USER_ID, token)).resolves.toEqual({
      status: 'claimed',
      method: 'email',
    });
    expect(rpc).toHaveBeenCalledWith('claim_posthog_signup_v1', { p_user_id: USER_ID });
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('does not repeat a claim already consumed by another request', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: false, error: null });
    rpc.mockReturnValueOnce({ abortSignal });
    const token = createSignupAnalyticsClaim(USER_ID, 'email') ?? '';
    const service = new SignupAnalyticsClaimService();

    await expect(service.claim(USER_ID, token)).resolves.toEqual({ status: 'pending' });
  });

  it('keeps a valid claim retryable after a temporary database error', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: null, error: new Error('temporary') });
    rpc.mockReturnValueOnce({ abortSignal });
    const token = createSignupAnalyticsClaim(USER_ID, 'email') ?? '';
    const service = new SignupAnalyticsClaimService();

    await expect(service.claim(USER_ID, token)).resolves.toEqual({ status: 'retry' });
  });
});
