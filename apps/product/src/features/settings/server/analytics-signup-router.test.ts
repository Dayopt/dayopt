import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const claim = vi.hoisted(() => vi.fn());
const setConsent = vi.hoisted(() => vi.fn());
const trackPostHogServerEvent = vi.hoisted(() => vi.fn());
vi.mock('./analytics-consent-service', () => ({
  AnalyticsConsentService: class {
    set(...args: unknown[]) {
      return setConsent(...args);
    }
  },
}));
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
    setConsent.mockResolvedValue({ allowed: true, updatedAt: '2026-09-24T00:00:00Z' });
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
    claim.mockResolvedValue({ status: 'claimed', method: 'email' });
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

  it('keeps a valid signup claim pending when account analytics consent is declined', async () => {
    claim.mockResolvedValue({ status: 'pending' });
    const ctx = createMockContext({ userId: 'user-1' });
    ctx.req.cookies = { [CLAIM_COOKIE]: 'signed-claim' };
    ctx.res.headers = new Headers();

    await expect(createCaller(ctx).claimSignupCompletion()).resolves.toEqual({ claimed: false });

    expect(ctx.res.headers?.get('set-cookie')).toBeNull();
    expect(trackPostHogServerEvent).not.toHaveBeenCalled();
  });

  it('claims a pending signup after account analytics consent is allowed', async () => {
    claim.mockResolvedValue({ status: 'claimed', method: 'google' });
    const ctx = createMockContext({ userId: 'user-1' });
    ctx.req.cookies = { [CLAIM_COOKIE]: 'signed-claim' };
    ctx.res.headers = new Headers();

    await expect(createCaller(ctx).setAnalyticsConsent({ allowed: true })).resolves.toEqual({
      allowed: true,
      updatedAt: '2026-09-24T00:00:00Z',
    });

    expect(setConsent).toHaveBeenCalledWith('user-1', true);
    expect(claim).toHaveBeenCalledWith('user-1', 'signed-claim');
    expect(trackPostHogServerEvent).toHaveBeenCalledWith({
      eventName: 'signup_completed',
      userId: 'user-1',
      sourceId: 'user-1',
      signupMethod: 'google',
    });
    expect(ctx.res.headers?.get('set-cookie')).toContain(`${CLAIM_COOKIE}=; Path=/; Max-Age=0`);
  });
});
