import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  extraErrorDataIntegration: vi.fn(() => ({ name: 'extra-error-data' })),
  init: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ ...sentry }));
vi.mock('@/lib/sentry/scrub-pii', () => ({
  scrubSentryBreadcrumb: vi.fn(),
  scrubSentrySpan: vi.fn(),
  scrubSentryTransaction: vi.fn(),
  withPIIScrub: vi.fn(() => vi.fn()),
}));

describe('Product server/edge Sentry runtime configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('SENTRY_DSN', 'https://public@example.ingest.sentry.io/1');
  });

  it('ProductionだけでNode/Edge clientを初期化する', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');

    await import('./sentry.server.config');
    await import('./sentry.edge.config');

    expect(sentry.init).toHaveBeenCalledTimes(2);
    expect(sentry.init).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dsn: 'https://public@example.ingest.sentry.io/1',
        enabled: true,
        environment: 'production',
        sendDefaultPii: false,
      }),
    );
    const serverSampler = sentry.init.mock.calls[0]?.[0].tracesSampler as (context: {
      inheritOrSampleWith: (sampleRate: number) => number;
    }) => number;
    const edgeSampler = sentry.init.mock.calls[1]?.[0].tracesSampler as (context: {
      inheritOrSampleWith: (sampleRate: number) => number;
    }) => number;

    expect(serverSampler({ inheritOrSampleWith: (sampleRate) => sampleRate })).toBe(0.1);
    expect(edgeSampler({ inheritOrSampleWith: (sampleRate) => sampleRate })).toBe(0.05);
  });

  it('NodeだけW3C traceparentを送出する（#2728）', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');

    await import('./sentry.server.config');
    await import('./sentry.edge.config');

    // SDK の既定は false で sentry-trace / baggage しか書かない。false のままだと
    // supabase-js は「非 W3C propagator」として header を付けない。
    expect(sentry.init.mock.calls[0]?.[0].propagateTraceparent).toBe(true);
    // Edge の @sentry/vercel-edge は OpenTelemetry の global propagator を登録しないので、
    // 有効にしても Supabase への伝播には効かない。非対称を意図として固定する。
    expect(sentry.init.mock.calls[1]?.[0].propagateTraceparent).toBeUndefined();
  });

  it.each(['preview', 'development'])('%sでは初期化しない', async (vercelEnv) => {
    vi.stubEnv('VERCEL_ENV', vercelEnv);

    await import('./sentry.server.config');
    await import('./sentry.edge.config');

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('ProductionでもDSNなしなら初期化しない', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('SENTRY_DSN', '');

    await import('./sentry.server.config');
    await import('./sentry.edge.config');

    expect(sentry.init).not.toHaveBeenCalled();
  });
});
