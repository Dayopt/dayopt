'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  isBrowserTelemetryConsentStorageChange,
  resolveAnalyticsConsentDetail,
} from '@dayopt/observability';
import { lazy, Suspense, useEffect, useState } from 'react';

import { PostHogWebAnalytics } from './PostHogWebAnalytics';

const Analytics = lazy(() =>
  import('@vercel/analytics/react').then((module) => ({ default: module.Analytics })),
);
const SpeedInsights = lazy(() =>
  import('@vercel/speed-insights/next').then((module) => ({ default: module.SpeedInsights })),
);

/** Load consented browser analytics; Vercel SDKs additionally require Production. */
export function BrowserTelemetry() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(hasAnalyticsConsent(getBrowserTelemetryConsentStorage()));

    const handleConsent = (event: Event) => {
      const analyticsConsent = resolveAnalyticsConsentDetail(
        (event as CustomEvent<unknown>).detail,
      );
      if (analyticsConsent !== null) {
        setEnabled(analyticsConsent && hasAnalyticsConsent(getBrowserTelemetryConsentStorage()));
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
      setEnabled(hasAnalyticsConsent(getBrowserTelemetryConsentStorage()));
    };

    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handleConsent);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handleConsent);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return (
    <>
      {enabled && process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' && (
        <Suspense fallback={null}>
          <Analytics />
          <SpeedInsights />
        </Suspense>
      )}
      {enabled && <PostHogWebAnalytics />}
    </>
  );
}
