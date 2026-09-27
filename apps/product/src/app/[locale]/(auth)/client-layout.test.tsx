import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  resolveSession: undefined as
    ((value: { data: { session: null }; error: null }) => void) | undefined,
}));

const analytics = vi.hoisted(() => ({
  capture: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  getIdentifiedUserId: vi.fn(() => null),
  signupClaim: vi.fn(),
  captureUnexpectedError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/ja/auth/signup',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock('@/components/ui/feedback/toast', () => ({ Toaster: () => null }));
vi.mock('./_providers/PublicProviders', () => ({
  PublicProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: auth.getSession,
      onAuthStateChange: auth.onAuthStateChange,
    },
  }),
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedAuthError: vi.fn(),
  captureUnexpectedError: analytics.captureUnexpectedError,
  observeAuthOperation: (_operation: string, callback: () => Promise<unknown>) => callback(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/tanstack-query/persist-storage', () => ({
  clearPersistedQueryCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth-error', () => ({
  getAuthErrorKey: vi.fn(),
  resolveAuthErrorKey: vi.fn(),
}));
vi.mock('@/lib/trpc/client', () => ({
  vanillaTrpc: { userSettings: { claimSignupCompletion: { mutate: analytics.signupClaim } } },
}));
vi.mock('@dayopt/observability', () => ({
  BROWSER_TELEMETRY_CONSENT_EVENT: 'cookieConsentChanged',
  capturePostHogBrowserEvent: analytics.capture,
  getBrowserTelemetryConsentStorage: () => null,
  getPostHogBrowserIdentifiedUserId: analytics.getIdentifiedUserId,
  hasAnalyticsConsent: () => true,
  identifyPostHogBrowser: analytics.identify,
  isBrowserTelemetryConsentStorageChange: () => false,
  resetPostHogBrowserIdentity: analytics.reset,
  startPostHogBrowser: analytics.start,
  stopPostHogBrowser: analytics.stop,
}));

import { PostHogProductAnalytics } from '@/app/_components/PostHogProductAnalytics';
import { useAuthStore } from '@/features/auth';
import { AuthClientLayout } from './client-layout';

describe('AuthClientLayout auth state initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.resolveSession = undefined;
    auth.getSession.mockImplementation(
      () =>
        new Promise<{ data: { session: null }; error: null }>((resolve) => {
          auth.resolveSession = resolve;
        }),
    );
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    useAuthStore.setState({
      user: null,
      session: null,
      loading: true,
      error: null,
      _sessionExpired: false,
    });
    window.history.replaceState({}, '', '/ja/auth/signup');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
  });

  it('signup view waits for auth resolution in the public auth layout', async () => {
    render(
      <AuthClientLayout>
        <PostHogProductAnalytics />
      </AuthClientLayout>,
    );

    await waitFor(() => expect(auth.getSession).toHaveBeenCalledOnce());
    expect(analytics.capture).not.toHaveBeenCalledWith('signup_viewed', expect.anything());

    await act(async () => {
      auth.resolveSession?.({ data: { session: null }, error: null });
    });

    await waitFor(() =>
      expect(analytics.capture).toHaveBeenCalledWith('signup_viewed', { screen: 'signup' }),
    );
    expect(analytics.capture).toHaveBeenCalledTimes(1);
  });
});
