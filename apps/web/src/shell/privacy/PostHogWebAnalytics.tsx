'use client';

import {
  capturePostHogPageview,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  startPostHogBrowser,
  stopPostHogBrowser,
} from '@dayopt/observability';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

function hasConsent(): boolean {
  return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
}

export function PostHogWebAnalytics() {
  const pathname = usePathname();
  const lastPage = useRef<string | null>(null);

  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
    if (process.env.NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED !== 'true' || !projectKey) return;
    let active = true;
    void startPostHogBrowser({
      projectKey,
      environment:
        process.env.NEXT_PUBLIC_VERCEL_ENV === 'production'
          ? 'production'
          : process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview'
            ? 'preview'
            : 'development',
      surface: 'web',
      hasConsent,
    }).then(() => {
      if (!active || !hasConsent()) return;
      const page = `${window.location.pathname}${window.location.search}`;
      if (lastPage.current === page) return;
      lastPage.current = page;
      capturePostHogPageview();
    });
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(
    () => () => {
      lastPage.current = null;
      stopPostHogBrowser();
    },
    [],
  );

  return null;
}
