// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
} from '@dayopt/observability';

vi.mock('./PostHogWebAnalytics', () => ({ PostHogWebAnalytics: () => null }));
vi.mock('@vercel/analytics/react', () => ({
  Analytics: () => <div data-testid="analytics" />,
}));
vi.mock('@vercel/speed-insights/next', () => ({
  SpeedInsights: () => <div data-testid="speed-insights" />,
}));

import { persistBrowserTelemetryConsent } from '@web/platform/privacy/browser-telemetry-consent';

import { BrowserTelemetry } from './BrowserTelemetry';

describe('Web analytics consent gate', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('mounts analytics once only after consent and removes it after revocation', async () => {
    render(<BrowserTelemetry />);

    expect(screen.queryByTestId('analytics')).toBeNull();
    expect(screen.queryByTestId('speed-insights')).toBeNull();

    act(() => persistBrowserTelemetryConsent(true));
    await waitFor(() => expect(screen.getAllByTestId('analytics')).toHaveLength(1));
    expect(screen.getAllByTestId('speed-insights')).toHaveLength(1);

    act(() => persistBrowserTelemetryConsent(true));
    await waitFor(() => expect(screen.getAllByTestId('analytics')).toHaveLength(1));
    expect(screen.getAllByTestId('speed-insights')).toHaveLength(1);

    act(() => persistBrowserTelemetryConsent(false));
    expect(screen.queryByTestId('analytics')).toBeNull();
    expect(screen.queryByTestId('speed-insights')).toBeNull();

    act(() => persistBrowserTelemetryConsent(true));
    act(() => {
      localStorage.removeItem(BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, { detail: null }));
    });
    expect(screen.queryByTestId('analytics')).toBeNull();
  });

  it('unmounts analytics after another tab refuses consent', async () => {
    persistBrowserTelemetryConsent(true);
    render(<BrowserTelemetry />);
    await waitFor(() => expect(screen.getByTestId('analytics')).not.toBeNull());

    act(() => {
      localStorage.setItem(
        BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
        JSON.stringify({ necessary: true, analytics: false, marketing: false, timestamp: 1 }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', { key: BROWSER_TELEMETRY_CONSENT_STORAGE_KEY }),
      );
    });

    expect(screen.queryByTestId('analytics')).toBeNull();
  });

  it('does not mount analytics in Preview even with consent', () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
    persistBrowserTelemetryConsent(true);

    render(<BrowserTelemetry />);

    expect(screen.queryByTestId('analytics')).toBeNull();
    expect(screen.queryByTestId('speed-insights')).toBeNull();
  });
});
