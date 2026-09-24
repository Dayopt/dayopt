import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  consent: true,
  userId: '00000000-0000-4000-8000-000000000001',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/calendar' }));
vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => string | null) =>
    selector({ user: { id: analytics.userId } }),
}));
vi.mock('@dayopt/observability', () => ({
  BROWSER_TELEMETRY_CONSENT_EVENT: 'cookieConsentChanged',
  capturePostHogBrowserEvent: analytics.capture,
  getBrowserTelemetryConsentStorage: () => null,
  hasAnalyticsConsent: () => analytics.consent,
  identifyPostHogBrowser: analytics.identify,
  isBrowserTelemetryConsentStorageChange: () => false,
  startPostHogBrowser: analytics.start,
  stopPostHogBrowser: analytics.stop,
}));

import { PostHogProductAnalytics } from './PostHogProductAnalytics';

describe('PostHog Product registration boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analytics.consent = true;
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/calendar?registered=email&view=week');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
  });

  it('captures a consented registration once and removes the one-time URL marker', async () => {
    const { unmount } = render(<PostHogProductAnalytics />);

    await waitFor(() =>
      expect(analytics.capture).toHaveBeenCalledWith('signup_completed', {
        signup_method: 'email',
      }),
    );
    expect(analytics.start).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'preview', surface: 'product' }),
    );
    expect(analytics.identify).toHaveBeenCalledWith(analytics.userId);
    expect(window.location.search).toBe('?view=week');

    unmount();
    window.history.replaceState({}, '', '/calendar?registered=email');
    render(<PostHogProductAnalytics />);
    await waitFor(() => expect(analytics.identify).toHaveBeenCalledTimes(2));
    expect(analytics.capture).toHaveBeenCalledTimes(1);
  });

  it('does not initialize or capture without browser consent', () => {
    analytics.consent = false;
    render(<PostHogProductAnalytics />);
    expect(analytics.start).not.toHaveBeenCalled();
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});
