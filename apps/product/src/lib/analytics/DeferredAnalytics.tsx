/**
 * DeferredAnalytics - 遅延読み込みのAnalyticsコンポーネント
 *
 * @description
 * Vercel Analytics/SpeedInsightsをrequestIdleCallback後に読み込み。
 * LCP/TBT改善のため、初期レンダリングをブロックしない。
 *
 * 効果: LCP -300ms, TBT -150ms
 */
'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  isBrowserTelemetryConsentStorageChange,
  resolveAnalyticsConsentDetail,
} from '@dayopt/observability';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

// 遅延読み込み（SSRなし）
const Analytics = dynamic(() => import('@vercel/analytics/react').then((mod) => mod.Analytics), {
  ssr: false,
});

const SpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((mod) => mod.SpeedInsights),
  { ssr: false },
);

export function DeferredAnalytics() {
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production') return;

    let idleHandle: number | undefined;
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    let scheduled = false;

    const cancelScheduledLoad = () => {
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (timerHandle !== undefined) clearTimeout(timerHandle);
      idleHandle = undefined;
      timerHandle = undefined;
      scheduled = false;
    };

    const scheduleLoad = () => {
      if (scheduled) return;
      scheduled = true;

      const enableIfStillAllowed = () => {
        scheduled = false;
        if (hasAnalyticsConsent(getBrowserTelemetryConsentStorage())) setShouldLoad(true);
      };

      if ('requestIdleCallback' in window) {
        idleHandle = window.requestIdleCallback(enableIfStillAllowed, { timeout: 2000 });
      } else {
        timerHandle = setTimeout(enableIfStillAllowed, 1000);
      }
    };

    const handleConsentChanged = (event: Event) => {
      const analyticsConsent = resolveAnalyticsConsentDetail(
        (event as CustomEvent<unknown>).detail,
      );
      if (analyticsConsent === null) return;

      if (analyticsConsent && hasAnalyticsConsent(getBrowserTelemetryConsentStorage())) {
        scheduleLoad();
      } else {
        cancelScheduledLoad();
        setShouldLoad(false);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;

      if (hasAnalyticsConsent(getBrowserTelemetryConsentStorage())) {
        scheduleLoad();
      } else {
        cancelScheduledLoad();
        setShouldLoad(false);
      }
    };

    if (hasAnalyticsConsent(getBrowserTelemetryConsentStorage())) {
      scheduleLoad();
    }

    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handleConsentChanged);
    window.addEventListener('storage', handleStorage);
    return () => {
      cancelScheduledLoad();
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handleConsentChanged);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return (
    <>
      {shouldLoad && (
        <>
          <SpeedInsights />
          <Analytics />
        </>
      )}
    </>
  );
}
