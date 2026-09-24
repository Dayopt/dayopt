import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  consent: true,
  loading: false,
  userId: '00000000-0000-4000-8000-000000000001',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  reset: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  signupClaim: vi.fn().mockResolvedValue({ claimed: true }),
  captureUnexpectedError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/calendar' }));
vi.mock('@/lib/trpc/client', () => ({
  vanillaTrpc: { userSettings: { claimSignupCompletion: { mutate: analytics.signupClaim } } },
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError: analytics.captureUnexpectedError }));
vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null; loading: boolean }) => unknown) =>
    selector({
      user: analytics.userId ? { id: analytics.userId } : null,
      loading: analytics.loading,
    }),
}));
vi.mock('@dayopt/observability', () => ({
  BROWSER_TELEMETRY_CONSENT_EVENT: 'cookieConsentChanged',
  capturePostHogBrowserEvent: analytics.capture,
  getBrowserTelemetryConsentStorage: () => null,
  hasAnalyticsConsent: () => analytics.consent,
  identifyPostHogBrowser: analytics.identify,
  resetPostHogBrowserIdentity: analytics.reset,
  isBrowserTelemetryConsentStorageChange: () => false,
  startPostHogBrowser: analytics.start,
  stopPostHogBrowser: analytics.stop,
}));

import { PostHogProductAnalytics } from './PostHogProductAnalytics';

describe('PostHog Product registration boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analytics.consent = true;
    analytics.loading = false;
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/calendar?signup_claim=1&view=week');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
  });

  it('asks the server to verify a signed registration claim and removes its URL marker', async () => {
    const { unmount } = render(<PostHogProductAnalytics />);

    await waitFor(() => expect(analytics.signupClaim).toHaveBeenCalledOnce());
    expect(analytics.start).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'preview', surface: 'product' }),
    );
    expect(analytics.identify).toHaveBeenCalledWith(analytics.userId);
    expect(window.location.search).toBe('?view=week');
    expect(analytics.capture).not.toHaveBeenCalledWith('signup_completed', expect.anything());

    unmount();
    window.history.replaceState({}, '', '/calendar?registered=email');
    render(<PostHogProductAnalytics />);
    await waitFor(() => expect(analytics.identify).toHaveBeenCalledTimes(2));
    expect(analytics.signupClaim).toHaveBeenCalledOnce();
  });

  it('does not initialize or capture without browser consent', () => {
    analytics.consent = false;
    render(<PostHogProductAnalytics />);
    expect(analytics.start).not.toHaveBeenCalled();
    expect(analytics.capture).not.toHaveBeenCalled();
    expect(analytics.signupClaim).not.toHaveBeenCalled();
  });

  it('reports a failed background claim without surfacing an analytics error in the UI', async () => {
    analytics.signupClaim.mockRejectedValueOnce(new Error('temporary tRPC failure'));
    render(<PostHogProductAnalytics />);

    await waitFor(() =>
      expect(analytics.captureUnexpectedError).toHaveBeenCalledWith(
        new Error('Signup analytics claim failed'),
        { feature: 'analytics', operation: 'claim_signup_completion' },
      ),
    );
  });

  it('waits for restored auth state and clears any prior browser identity before tracking', async () => {
    analytics.loading = true;
    const view = render(<PostHogProductAnalytics />);

    expect(analytics.start).not.toHaveBeenCalled();
    expect(analytics.capture).not.toHaveBeenCalled();

    analytics.loading = false;
    view.rerender(<PostHogProductAnalytics />);

    await waitFor(() => expect(analytics.identify).toHaveBeenCalledWith(analytics.userId));
    expect(analytics.reset.mock.invocationCallOrder[0]).toBeLessThan(
      analytics.identify.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
