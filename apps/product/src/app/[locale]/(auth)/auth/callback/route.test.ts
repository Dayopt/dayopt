import { beforeEach, describe, expect, it, vi } from 'vitest';

const exchangeCodeForSession = vi.hoisted(() => vi.fn());
const deliverWelcomeEmailOnce = vi.hoisted(() => vi.fn());
const createSignupAnalyticsClaim = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { exchangeCodeForSession } }),
}));
vi.mock('@/features/auth/server/welcome-email', () => ({ deliverWelcomeEmailOnce }));
vi.mock('@/lib/analytics/signup-analytics-claim', () => ({
  createSignupAnalyticsClaim,
  SIGNUP_ANALYTICS_CLAIM_COOKIE: '__Host-dayopt_signup_claim',
  SIGNUP_ANALYTICS_CLAIM_MAX_AGE_SECONDS: 600,
}));
vi.mock('@/lib/sentry', () => ({
  observeAuthOperation: (_name: string, operation: () => unknown) => operation(),
}));

import { GET } from './route';

function claimMarkerIn(response: Response): string | null {
  return new URL(response.headers.get('location') ?? '').searchParams.get('signup_claim');
}

describe('OAuth registration analytics redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exchangeCodeForSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
    createSignupAnalyticsClaim.mockReturnValue('signed-token');
  });

  it('issues a short-lived signed claim only for the first confirmed account creation', async () => {
    deliverWelcomeEmailOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = new Request('https://app.dayopt.app/auth/callback?code=valid');

    const first = await GET(request);
    const second = await GET(request);
    expect(claimMarkerIn(first)).toBe('1');
    expect(first.headers.get('set-cookie')).toContain('__Host-dayopt_signup_claim=signed-token');
    expect(claimMarkerIn(second)).toBeNull();
    expect(createSignupAnalyticsClaim).toHaveBeenCalledOnce();
    expect(createSignupAnalyticsClaim).toHaveBeenCalledWith('user-1', 'google');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('valid');
  });

  it('does not mark an unsuccessful code exchange', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: new Error('invalid code') });

    expect(
      claimMarkerIn(await GET(new Request('https://app.dayopt.app/auth/callback?code=invalid'))),
    ).toBeNull();
    expect(deliverWelcomeEmailOnce).not.toHaveBeenCalled();
  });
});
