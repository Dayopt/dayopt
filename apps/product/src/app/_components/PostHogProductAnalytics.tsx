'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  capturePostHogBrowserEvent,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  identifyPostHogBrowser,
  isBrowserTelemetryConsentStorageChange,
  resetPostHogBrowserIdentity,
  startPostHogBrowser,
  stopPostHogBrowser,
} from '@dayopt/observability';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuthStore } from '@/features/auth';
import { captureUnexpectedError } from '@/lib/sentry';
import { vanillaTrpc } from '@/lib/trpc/client';

function hasConsent(): boolean {
  return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
}

export function PostHogProductAnalytics() {
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const authLoading = useAuthStore((state) => state.loading);
  const previousUserId = useRef<string | null>(null);
  const authIdentityInitialized = useRef(false);
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
    if (authLoading) return;

    const identityChanged = !authIdentityInitialized.current || previousUserId.current !== userId;

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
      if (identityChanged) resetPostHogBrowserIdentity();
      authIdentityInitialized.current = true;
      previousUserId.current = userId;
      if (userId) identifyPostHogBrowser(userId);

      if (pathname.endsWith('/auth/signup') && lastSignupView.current !== pathname) {
        lastSignupView.current = pathname;
        capturePostHogBrowserEvent('signup_viewed', { screen: 'signup' });
      }

      const params = new URLSearchParams(window.location.search);
      if (userId && params.get('signup_claim') === '1') {
        params.delete('signup_claim');
        const remaining = params.toString();
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
        );
        void vanillaTrpc.userSettings.claimSignupCompletion.mutate().catch(() => {
          captureUnexpectedError(new Error('Signup analytics claim failed'), {
            feature: 'analytics',
            operation: 'claim_signup_completion',
          });
        });
      }
    });
    return () => {
      active = false;
    };
  }, [authLoading, pathname, userId, consentVersion]);

  useEffect(() => () => stopPostHogBrowser(), []);

  return null;
}
