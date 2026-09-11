import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1967 の回帰確認。実 `@upstash/redis` を使い、下位 fetch がハングし続けても
 * `REDIS_CHECK_TIMEOUT_MS` で abort され `GET()` 自体が張り付かないことを固定する。
 *
 * `route.test.ts` は `@upstash/redis` を丸ごとモックしているため、`checkRedis()` が
 * 実際に signal を下位 HTTP 呼び出しへ渡しているかまでは検証できない。ここでは
 * `@upstash/redis` を実物のまま使い、`global.fetch` だけを「signal が abort されるまで
 * 永久に pending」なモックに差し替える（実 fetch の abort 契約だけを再現する）。
 *
 * `checkRedis` が `Promise.race` で見かけ上打ち切るだけの実装（signal を fetch まで
 * 渡さない）に戻ると、このモックは abort を検知できず永久に pending のままになり、
 * この test 自体が timeout で fail する。
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
  rpc: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
  },
}));

vi.mock('@/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, property) {
        return typeof property === 'string' ? process.env[property] : undefined;
      },
    },
  ),
}));

import { GET } from './route';

describe('GET /api/health — checkRedis timeout（実 @upstash/redis）', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'service-role-sentinel');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'anon-key-sentinel');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_TARGET_ENV', '');
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    mocks.limit.mockResolvedValue({ data: [], error: null });
    mocks.select.mockReturnValue({ limit: mocks.limit });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.createClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });

    originalFetch = global.fetch;
    global.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return; // signal 無しなら本物の無応答同様ハングし続ける

        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () =>
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')),
          { once: true },
        );
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it(
    'Upstash が無応答でも timeout で abort し、GET() が張り付かず redis:error を返す',
    { timeout: 8_000 },
    async () => {
      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.checks).toEqual({ database: 'ok', redis: 'error' });
    },
  );
});
