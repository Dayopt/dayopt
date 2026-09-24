// @vitest-environment happy-dom

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  capturePageview: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/ja/' }));
vi.mock('@dayopt/observability', () => ({
  capturePostHogPageview: analytics.capturePageview,
  getBrowserTelemetryConsentStorage: () => null,
  hasAnalyticsConsent: () => true,
  startPostHogBrowser: analytics.start,
  stopPostHogBrowser: analytics.stop,
}));

import { PostHogWebAnalytics } from './PostHogWebAnalytics';

describe('PostHog Web analytics cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('clears the shared project identity when the consented Web component unmounts', async () => {
    const { unmount } = render(<PostHogWebAnalytics />);

    await waitFor(() => expect(analytics.start).toHaveBeenCalledOnce());
    expect(analytics.start).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'phc_test', surface: 'web' }),
    );

    unmount();

    expect(analytics.stop).toHaveBeenCalledWith('phc_test');
  });
});
