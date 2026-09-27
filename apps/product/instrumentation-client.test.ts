import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
} from '@dayopt/observability';

const sentry = vi.hoisted(() => ({
  browserTracingIntegration: vi.fn(() => ({ name: 'browser-tracing' })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(() => ({ getOptions: () => sentry.clientOptions })),
  init: vi.fn(),
  clientOptions: { enabled: true },
  setTag: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ ...sentry }));

function consentDetail(analytics: boolean) {
  return { necessary: true, analytics, marketing: false, timestamp: 1 } as const;
}

function persistAndNotify(analytics: boolean): void {
  const consent = consentDetail(analytics);
  localStorage.setItem(BROWSER_TELEMETRY_CONSENT_STORAGE_KEY, JSON.stringify(consent));
  window.dispatchEvent(new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, { detail: consent }));
}

describe('Product browser Sentry consent lifecycle', () => {
  let reloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sentry.clientOptions.enabled = true;
    localStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.ingest.sentry.io/1');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production');
    reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    reloadSpy.mockRestore();
  });

  it('does not initialize before consent and disables/re-enables one client', async () => {
    await import('./instrumentation-client');
    expect(sentry.init).not.toHaveBeenCalled();
    expect('__DAYOPT_PRODUCT_SENTRY_SMOKE__' in window).toBe(false);

    persistAndNotify(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.clientOptions.enabled).toBe(true);
    expect('__DAYOPT_PRODUCT_SENTRY_SMOKE__' in window).toBe(false);
    const tracesSampler = sentry.init.mock.calls[0]?.[0].tracesSampler as (context: {
      inheritOrSampleWith: (sampleRate: number) => number;
    }) => number;
    expect(tracesSampler({ inheritOrSampleWith: (sampleRate) => sampleRate })).toBe(0.1);

    persistAndNotify(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, { detail: { analytics: false } }),
    );
    expect(sentry.clientOptions.enabled).toBe(true);

    persistAndNotify(false);
    expect(sentry.clientOptions.enabled).toBe(false);
    expect('__DAYOPT_PRODUCT_SENTRY_SMOKE__' in window).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    persistAndNotify(true);
    expect(sentry.clientOptions.enabled).toBe(false);
    expect(sentry.init).toHaveBeenCalledTimes(1);

    localStorage.removeItem(BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, { detail: null }));
    expect(sentry.clientOptions.enabled).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('follows consent refusal and storage.clear() from another tab', async () => {
    await import('./instrumentation-client');

    persistAndNotify(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);

    localStorage.setItem(
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify(consentDetail(false)),
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: BROWSER_TELEMETRY_CONSENT_STORAGE_KEY }),
    );
    expect(sentry.clientOptions.enabled).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(sentry.clientOptions.enabled).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the Vercel Preview bundle free of initialized Sentry', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'preview');
    localStorage.setItem(
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify(consentDetail(true)),
    );

    await import('./instrumentation-client');

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('labels the explicitly bound persistent Integration project', async () => {
    vi.stubEnv('NEXT_PUBLIC_DAYOPT_ENVIRONMENT', 'integration');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://tilwaprottpyhlfoggbb.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_TARGET_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF', 'integration');
    localStorage.setItem(
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify(consentDetail(true)),
    );

    await import('./instrumentation-client');

    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init.mock.calls[0]?.[0].environment).toBe('integration');
    expect(sentry.init.mock.calls[0]?.[0].enabled).toBe(true);
  });

  it('does not use NODE_ENV as a fallback for local production-mode starts', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
    vi.stubEnv('NODE_ENV', 'production');
    localStorage.setItem(
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify(consentDetail(true)),
    );

    await import('./instrumentation-client');

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('treats inaccessible browser storage as no consent without throwing', async () => {
    const storageSpy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    await expect(import('./instrumentation-client')).resolves.toBeDefined();
    expect(sentry.init).not.toHaveBeenCalled();

    storageSpy.mockRestore();
  });
});
