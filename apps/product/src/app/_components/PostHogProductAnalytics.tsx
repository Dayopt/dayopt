'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  capturePostHogBrowserEvent,
  getBrowserTelemetryConsentStorage,
  getPostHogBrowserIdentifiedUserId,
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
import { resolveDayoptEnvironment } from '@/lib/dayopt-environment';
import { captureUnexpectedError } from '@/lib/sentry';
import { vanillaTrpc } from '@/lib/trpc/client';

function hasConsent(): boolean {
  return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
}

export function PostHogProductAnalytics() {
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const authLoading = useAuthStore((state) => state.loading);
  const lastSignupView = useRef<string | null>(null);
  const [consentVersion, setConsentVersion] = useState(0);

  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
    const changed = () => {
      if (!hasConsent()) {
        stopPostHogBrowser(projectKey);
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
    if (authLoading || !userId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('signup_claim') !== '1') return;

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
  }, [authLoading, pathname, userId]);

  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
    const environment = resolveDayoptEnvironment({
      dayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
      publicDayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
      vercelEnvironment: process.env.NEXT_PUBLIC_VERCEL_ENV,
      vercelTargetEnvironment: process.env.NEXT_PUBLIC_VERCEL_TARGET_ENV,
      vercelGitCommitRef: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF,
      vercelProjectId: process.env.NEXT_PUBLIC_VERCEL_PROJECT_ID,
      vercelBranchUrl: process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL,
      vercelUrl: process.env.NEXT_PUBLIC_VERCEL_URL,
      appUrl: process.env.NEXT_PUBLIC_APP_URL,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });
    if (!hasConsent()) {
      stopPostHogBrowser(projectKey);
      return;
    }
    if (environment === 'integration' || environment === 'unknown') {
      stopPostHogBrowser(projectKey);
      return;
    }
    if (authLoading) return;
    if (process.env.NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED !== 'true' || !projectKey) return;

    let active = true;
    void startPostHogBrowser({
      projectKey,
      environment,
      surface: 'product',
      hasConsent,
    }).then(() => {
      if (!active || !hasConsent()) return;
      const previouslyIdentifiedUserId = getPostHogBrowserIdentifiedUserId();
      if (previouslyIdentifiedUserId && previouslyIdentifiedUserId !== userId) {
        resetPostHogBrowserIdentity();
      }
      if (userId) identifyPostHogBrowser(userId);

      if (pathname.endsWith('/auth/signup') && lastSignupView.current !== pathname) {
        lastSignupView.current = pathname;
        capturePostHogBrowserEvent('signup_viewed', { screen: 'signup' });
      }
    });
    return () => {
      active = false;
    };
  }, [authLoading, pathname, userId, consentVersion]);

  useEffect(() => {
    const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
    return () => stopPostHogBrowser(projectKey);
  }, []);

  return null;
}
