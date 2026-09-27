// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
} from '@dayopt/observability';

const dynamicState = vi.hoisted(() => ({ callCount: 0 }));

vi.mock('./PostHogWebAnalytics', () => ({ PostHogWebAnalytics: () => null }));

vi.mock('next/dynamic', () => ({
  default: () => {
    const testId = dynamicState.callCount++ === 0 ? 'analytics' : 'speed-insights';
    return function MockTelemetryComponent() {
      return <div data-testid={testId} />;
    };
  },
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

  it('mounts analytics once only after consent and removes it after revocation', () => {
    render(<BrowserTelemetry />);

    expect(screen.queryByTestId('analytics')).toBeNull();
    expect(screen.queryByTestId('speed-insights')).toBeNull();

    act(() => persistBrowserTelemetryConsent(true));
    expect(screen.getAllByTestId('analytics')).toHaveLength(1);
    expect(screen.getAllByTestId('speed-insights')).toHaveLength(1);

    act(() => persistBrowserTelemetryConsent(true));
    expect(screen.getAllByTestId('analytics')).toHaveLength(1);
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

  it('unmounts analytics after another tab refuses consent', () => {
    persistBrowserTelemetryConsent(true);
    render(<BrowserTelemetry />);
    expect(screen.getByTestId('analytics')).not.toBeNull();

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
