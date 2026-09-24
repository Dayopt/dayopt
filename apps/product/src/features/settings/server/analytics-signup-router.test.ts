import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const claim = vi.hoisted(() => vi.fn());
const trackPostHogServerEvent = vi.hoisted(() => vi.fn());
vi.mock('./signup-analytics-claim-service', () => ({
  SignupAnalyticsClaimService: class {
    claim(...args: unknown[]) {
      return claim(...args);
    }
  },
}));
vi.mock('@/lib/analytics/posthog-server', () => ({ trackPostHogServerEvent }));

import { userSettingsRouter } from './router';

const createCaller = createCallerFactory(userSettingsRouter);
const CLAIM_COOKIE = '__Host-dayopt_signup_claim';

describe('userSettings.claimSignupCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when a forged URL marker has no server-issued cookie', async () => {
    const ctx = createMockContext({ userId: 'user-1' });
    ctx.req.cookies = {};
    ctx.res.headers = new Headers();

    await expect(createCaller(ctx).claimSignupCompletion()).resolves.toEqual({ claimed: false });
    expect(claim).not.toHaveBeenCalled();
    expect(trackPostHogServerEvent).not.toHaveBeenCalled();
  });

  it('tracks only a verified, one-time account claim and clears its cookie', async () => {
    claim.mockResolvedValue('email');
    const ctx = createMockContext({ userId: 'user-1' });
    ctx.req.cookies = { [CLAIM_COOKIE]: 'signed-claim' };
    ctx.res.headers = new Headers();

    await expect(createCaller(ctx).claimSignupCompletion()).resolves.toEqual({ claimed: true });

    expect(claim).toHaveBeenCalledWith('user-1', 'signed-claim');
    expect(trackPostHogServerEvent).toHaveBeenCalledWith({
      eventName: 'signup_completed',
      userId: 'user-1',
      sourceId: 'user-1',
      signupMethod: 'email',
    });
    expect(ctx.res.headers?.get('set-cookie')).toContain(`${CLAIM_COOKIE}=; Path=/; Max-Age=0`);
  });
});
