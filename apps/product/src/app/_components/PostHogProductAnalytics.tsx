'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  capturePostHogBrowserEvent,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  identifyPostHogBrowser,
  isBrowserTelemetryConsentStorageChange,
  startPostHogBrowser,
  stopPostHogBrowser,
} from '@dayopt/observability';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuthStore } from '@/features/auth';

function hasConsent(): boolean {
  return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
}

export function PostHogProductAnalytics() {
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const previousUserId = useRef<string | null>(null);
  const lastSignupView = useRef<string | null>(null);
  const [consentVersion, setConsentVersion] = useState(0);

  useEffect(() => {
    const changed = () => {
      if (!hasConsent()) {
        stopPostHogBrowser();
        lastSignupView.current = null;
      }
      setConsentVersion((version) => version + 1);
    };
    const storageChanged = (event: StorageEvent) => {
      if (isBrowserTelemetryConsentStorageChange(event.key)) changed();
    };
    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, changed);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, changed);
      window.removeEventListener('storage', storageChanged);
    };
  }, []);

  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== userId) stopPostHogBrowser();
    previousUserId.current = userId;

    const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
    if (process.env.NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED !== 'true' || !projectKey || !hasConsent())
      return;
    let active = true;
    void startPostHogBrowser({
      projectKey,
      environment:
        process.env.NEXT_PUBLIC_VERCEL_ENV === 'production'
          ? 'production'
          : process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview'
            ? 'preview'
            : 'development',
      surface: 'product',
      hasConsent,
    }).then(() => {
      if (!active || !hasConsent()) return;
      if (userId) identifyPostHogBrowser(userId);

      if (pathname.endsWith('/auth/signup') && lastSignupView.current !== pathname) {
        lastSignupView.current = pathname;
        capturePostHogBrowserEvent('signup_viewed', { screen: 'signup' });
      }

      const params = new URLSearchParams(window.location.search);
      const method = params.get('registered');
      if (userId && (method === 'email' || method === 'google')) {
        const marker = `dayopt_posthog_signup:${userId}`;
        try {
          if (sessionStorage.getItem(marker) !== '1') {
            capturePostHogBrowserEvent('signup_completed', { signup_method: method });
            sessionStorage.setItem(marker, '1');
          }
        } catch {
          // Storage can be unavailable; the one-time auth redirect still permits capture.
          capturePostHogBrowserEvent('signup_completed', { signup_method: method });
        }
        params.delete('registered');
        const remaining = params.toString();
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [pathname, userId, consentVersion]);

  useEffect(() => () => stopPostHogBrowser(), []);

  return null;
}
