import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  isBrowserTelemetryConsentStorageChange,
  resolveAnalyticsConsentDetail,
} from '@dayopt/observability';
import { config as configureZod } from 'zod';

import {
  loadBrowserSentryRuntime,
  type BrowserSentryRuntime,
} from './src/platform/observability/browser-sentry-runtime';

// Production CSP forbids eval. Configure Zod before application schemas are constructed.
configureZod({ jitless: true });

let sentryRuntime: BrowserSentryRuntime | undefined;
export const onRouterTransitionStart = (
  ...args: Parameters<BrowserSentryRuntime['captureRouterTransitionStart']>
): void => {
  sentryRuntime?.captureRouterTransitionStart(...args);
};

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const isProduction = process.env.NEXT_PUBLIC_VERCEL_ENV === 'production';
let initialized = false;
let loading = false;
let browserTelemetryAllowed = false;
let revocationReloadRequested = false;

function hasStoredAnalyticsConsent(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
  } catch {
    return false;
  }
}

function initializeBrowserSentry(): void {
  if (
    initialized ||
    loading ||
    !browserTelemetryAllowed ||
    !isProduction ||
    !dsn ||
    !hasStoredAnalyticsConsent()
  ) {
    return;
  }

  loading = true;
  void loadBrowserSentryRuntime()
    .then((runtime) => {
      loading = false;
      // A user can withdraw consent while the SDK chunk is loading.
      if (
        initialized ||
        revocationReloadRequested ||
        !browserTelemetryAllowed ||
        !hasStoredAnalyticsConsent()
      )
        return;
      sentryRuntime = runtime;
      runtime.initialize(dsn);
      initialized = true;
    })
    .catch(() => {
      loading = false;
      sentryRuntime?.setEnabled(false);
      // Optional monitoring must not prevent reading, signup or consent withdrawal.
      console.warn('[telemetry] Browser error monitoring could not be loaded.');
    });
}

function setSentryClientEnabled(enabled: boolean): void {
  sentryRuntime?.setEnabled(enabled);
}

function applyBrowserTelemetryConsent(allowed: boolean): void {
  browserTelemetryAllowed = allowed && hasStoredAnalyticsConsent();

  if (!browserTelemetryAllowed) {
    setSentryClientEnabled(false);
    if (initialized && !revocationReloadRequested) {
      revocationReloadRequested = true;
      try {
        window.location.reload();
      } catch {
        // The client stays disabled and cannot be re-enabled in this document.
      }
    }
    return;
  }

  if (revocationReloadRequested) return;

  if (initialized) {
    setSentryClientEnabled(true);
  } else {
    initializeBrowserSentry();
  }
}

if (isProduction && dsn && typeof window !== 'undefined') {
  browserTelemetryAllowed = hasStoredAnalyticsConsent();

  if (browserTelemetryAllowed) {
    initializeBrowserSentry();
  }

  const handleConsent = (event: Event) => {
    const analyticsConsent = resolveAnalyticsConsentDetail((event as CustomEvent<unknown>).detail);
    if (analyticsConsent === null) return;

    applyBrowserTelemetryConsent(analyticsConsent);
  };
  const handleStorage = (event: StorageEvent) => {
    if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
    applyBrowserTelemetryConsent(hasStoredAnalyticsConsent());
  };

  window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handleConsent);
  window.addEventListener('storage', handleStorage);
}
