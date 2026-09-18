import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  captureRequestError: vi.fn(),
  extraErrorDataIntegration: vi.fn(() => ({ name: 'extra-error-data' })),
  init: vi.fn(),
  setTags: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureRequestError: sentry.captureRequestError,
  extraErrorDataIntegration: sentry.extraErrorDataIntegration,
  init: sentry.init,
  withScope: (callback: (scope: { setTags: typeof sentry.setTags }) => void) =>
    callback({ setTags: sentry.setTags }),
}));
vi.mock('@/lib/sentry/scrub-pii', () => ({
  scrubSentryBreadcrumb: vi.fn(),
  scrubSentrySpan: vi.fn(),
  scrubSentryTransaction: vi.fn(),
  withPIIScrub: vi.fn(() => vi.fn()),
}));

import { onRequestError, register } from './instrumentation';

/** supabase-js が tracing runtime を探す globalThis key（dist/tracingRegistry の実測値）。 */
const SUPABASE_TRACE_EXTRACTOR_KEY = Symbol.for('@supabase/supabase-js.traceContextExtractor');

type MutableGlobal = typeof globalThis & Record<symbol, unknown>;

const request = {
  path: '/day?query=private',
  method: 'GET',
  headers: { 'x-vercel-id': 'iad1::product-request-123' },
};
const context = {
  routerKind: 'App Router' as const,
  routePath: '/[locale]/day',
  routeType: 'route' as const,
  revalidateReason: undefined,
  renderSource: undefined,
};

describe('Product onRequestError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('SENTRY_DSN', 'https://public@example.ingest.sentry.io/1');
  });

  it('preserves Next request capture with allowlisted correlation tags', async () => {
    const original = new Error('server render failed');

    await onRequestError(original, request, context);

    expect(sentry.setTags).toHaveBeenCalledWith({
      feature: 'product',
      operation: 'next_request_error',
      route: '/[locale]/day',
      requestId: 'iad1::product-request-123',
      source: 'nextjs',
    });
    expect(sentry.captureRequestError).toHaveBeenCalledWith(original, request, context);
  });

  it('does not capture Preview request failures', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');

    await onRequestError(new Error('preview failure'), request, context);

    expect(sentry.captureRequestError).not.toHaveBeenCalled();
  });

  it('loads the Node Sentry config from the src instrumentation convention', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    await register();

    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@example.ingest.sentry.io/1',
        enabled: true,
        environment: 'production',
      }),
    );
  });

  it('Node entry で Supabase tracing runtime を登録する（#2728）', async () => {
    // supabase-js は fetch のたびにこの key を読む。未登録だと tracePropagation を
    // 有効にしていても warn を 1 度出すだけで header が付かない（silent no-op）。
    // 副作用 import は externalize されて module registry のリセットが効かないため、
    // key を消して再 import する形にはしない（消すと再登録できない）。
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    await register();

    expect(typeof (globalThis as MutableGlobal)[SUPABASE_TRACE_EXTRACTOR_KEY]).toBe('function');
  });
});
