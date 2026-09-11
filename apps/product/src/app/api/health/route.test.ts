import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
  redisPing: vi.fn(),
  redisConstructorOptions: [] as Array<{ url: string; token: string; signal?: () => AbortSignal }>,
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  envValidationError: false,
  healthLimit: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@upstash/redis', () => ({
  Redis: class Redis {
    constructor(options: { url: string; token: string; signal?: () => AbortSignal }) {
      mocks.redisConstructorOptions.push(options);
    }
    ping() {
      return mocks.redisPing();
    }
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
  },
}));

vi.mock('@/lib/rate-limit/upstash', () => ({
  healthCheckGlobalRateLimit: { limit: mocks.healthLimit },
}));

vi.mock('@/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, property) {
        if (mocks.envValidationError) {
          throw new Error('env-validation-sentinel');
        }
        return typeof property === 'string' ? process.env[property] : undefined;
      },
    },
  ),
}));

import { GET } from './route';

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-sentinel');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-sentinel');
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '0.32.0');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_TARGET_ENV', '');
    vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'production');
    vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app');
    vi.stubEnv('MCP_CANONICAL_RESOURCE_URI', 'https://mcp.dayopt.app');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    mocks.envValidationError = false;
    mocks.redisConstructorOptions = [];
    mocks.healthLimit.mockResolvedValue({ success: true });
    mocks.rpc.mockImplementation(() =>
      Promise.resolve({
        data: [
          process.env.MCP_OAUTH_ENVIRONMENT === 'preview'
            ? {
                environment: 'preview',
                authorization_server_uri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
                resource_uri: 'https://product-git-codex-mcp-preview-dayopt.vercel.app',
                supabase_project_ref: 'abcdefghijklmnopqrst',
                provisioned_at: '2026-07-29T00:00:00.000Z',
              }
            : {
                environment: 'production',
                authorization_server_uri: 'https://app.dayopt.app',
                resource_uri: 'https://mcp.dayopt.app',
                supabase_project_ref: null,
                provisioned_at: '2026-07-26T00:00:00.000Z',
              },
        ],
        error: null,
      }),
    );
    mocks.limit.mockResolvedValue({ data: [], error: null });
    mocks.redisPing.mockResolvedValue('PONG');
    mocks.select.mockReturnValue({ limit: mocks.limit });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.createClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('profilesへの空結果SELECT成功をhealthyとして扱う', async () => {
    const memoryUsage = vi.spyOn(process, 'memoryUsage');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('0.32.0');
    expect(body.checks).toEqual({ database: 'ok', redis: 'skipped' });
    expect(body.checks).not.toHaveProperty('memory');
    expect(mocks.from).toHaveBeenCalledWith('profiles');
    expect(mocks.select).toHaveBeenCalledWith('id');
    expect(mocks.limit).toHaveBeenCalledWith(1);
    expect(memoryUsage).not.toHaveBeenCalled();
  });

  it('productionではstatusだけをno-storeで返す', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'healthy' });
    expect(Object.keys(body)).toEqual(['status']);
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
  });

  it('Vercel PreviewではNODE_ENVがproductionでも診断情報を返す', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('NODE_ENV', 'production');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ database: 'ok', redis: 'skipped' });
  });

  it('OAuth-enabled Previewをproject refと依存必須かつ詳細非公開として扱う', async () => {
    stubPreviewOperationalEnvironment();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv(
      'SUPABASE_SERVICE_ROLE_KEY',
      createUnsignedTestJwt({
        role: 'service_role',
        ref: 'abcdefghijklmnopqrst',
      }),
    );
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://preview-example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'preview-redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy' });
    expect(mocks.rpc).toHaveBeenCalledWith('get_mcp_environment_identity_v1');
  });

  it('OAuth-enabled PreviewはSupabase project ref driftをunhealthyにする', async () => {
    stubPreviewOperationalEnvironment();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv(
      'SUPABASE_SERVICE_ROLE_KEY',
      createUnsignedTestJwt({
        role: 'service_role',
        ref: 'zyxwvutsrqponmlkjihg',
      }),
    );
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://preview-example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'preview-redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
  });

  it.each(['PGRST202', 'PGRST205'])('DB query error %sをunhealthyにする', async (code) => {
    mocks.limit.mockResolvedValue({
      data: null,
      error: {
        code,
        message: 'database-message-sentinel',
        details: 'database-details-sentinel',
        hint: 'database-hint-sentinel',
      },
    });
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[health] dependency check failed',
      expect.objectContaining({ database: 'error', redis: 'ok' }),
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('database-message-sentinel');
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('service-role-sentinel');
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('example.supabase.co');
  });

  it.each([
    {
      name: 'missing',
      result: { data: [], error: null },
    },
    {
      name: 'mismatched',
      result: {
        data: [
          {
            environment: 'preview',
            authorization_server_uri: 'https://product-git-other-dayopt.vercel.app',
            resource_uri: 'https://product-git-other-dayopt.vercel.app',
            provisioned_at: '2026-07-26T00:00:00.000Z',
          },
        ],
        error: null,
      },
    },
  ])('production DB identity $nameをreadiness失敗にする', async ({ result }) => {
    mocks.rpc.mockResolvedValue(result);
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      'product-git-other-dayopt.vercel.app',
    );
  });

  it('DB queryのtimeoutをunhealthyにする', async () => {
    mocks.limit.mockRejectedValue(new Error('timeout-message-sentinel'));
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[health] dependency check failed',
      expect.objectContaining({ database: 'error', redis: 'ok' }),
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('timeout-message-sentinel');
  });

  it('非productionのDB設定不足をdegradedとしてclientを作らず返す', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('degraded');
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it('productionのservice-role secret不足をunhealthyとして扱う', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[health] dependency check failed',
      expect.objectContaining({ database: 'error', redis: 'ok' }),
    );
  });

  it('operational環境変数schemaの失敗をnetwork check前にunhealthyとして扱う', async () => {
    mocks.envValidationError = true;
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.redisPing).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[health] environment check failed',
      expect.objectContaining({ status: 'unhealthy' }),
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('env-validation-sentinel');
  });

  it('productionのRedis設定不足をunhealthyとして扱う', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });

  it('RedisのPONGをhealthyとして扱う', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('Redisのnon-PONGをdegradedとして扱う', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');
    mocks.redisPing.mockResolvedValue('NOT_PONG');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ database: 'ok', redis: 'warning' });
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it('Redis client を下位 fetch を abort できる signal factory 付きで生成する', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');

    await GET();

    expect(mocks.redisConstructorOptions).toHaveLength(1);
    const { signal } = mocks.redisConstructorOptions[0]!;
    expect(typeof signal).toBe('function');
    // Promise.race での見かけ上の打ち切りではなく、fetch レイヤの signal で abort する
    // 実装であることを固定する（呼ぶたびに実 AbortSignal を返す = 下位 fetch へ渡せる形）。
    expect(signal!()).toBeInstanceOf(AbortSignal);
  });

  it('Redis errorをunhealthyとして扱う', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token-sentinel');
    mocks.redisPing.mockRejectedValue(new Error('redis-token-sentinel'));

    const response = await GET();

    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('unhealthy');
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('redis-token-sentinel');
  });

  it('上限を超えたら依存を叩かずに直近の結果を返す', async () => {
    // 無認証・無制限のままだと、1 リクエストごとに service-role client の生成 →
    // identity RPC → profiles SELECT → Redis PING を駆動できる（#2721 D-09）。
    const first = await GET();
    expect(first.status).toBe(200);
    const callsAfterFirst = mocks.createClient.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    mocks.healthLimit.mockResolvedValueOnce({ success: false });
    const replayed = await GET();

    expect(replayed.status).toBe(first.status);
    expect(replayed.headers.get('X-Health-Check-Replayed')).toBe('true');
    // 依存を一切叩いていない。
    expect(mocks.createClient.mock.calls.length).toBe(callsAfterFirst);
  });

  it('障害中の結果も記憶し、古い healthy を返さない', async () => {
    // 成功だけを覚えると、障害が始まった後に上限を超えた瞬間から最大 60 秒
    // 「古い healthy」を返し、外形監視のアラートがその分遅れる。
    const healthy = await GET();
    expect(healthy.status).toBe(200);

    mocks.limit.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'database-message-sentinel',
        details: 'database-details-sentinel',
        hint: 'database-hint-sentinel',
      },
    });
    const unhealthy = await GET();
    expect(unhealthy.status).toBe(503);

    mocks.healthLimit.mockResolvedValueOnce({ success: false });
    const replayed = await GET();

    expect(replayed.status).toBe(503);
    expect(replayed.headers.get('X-Health-Check-Replayed')).toBe('true');
    // 監視側が stale を判別できるよう経過時間を出す。
    expect(Number(replayed.headers.get('X-Health-Check-Age-Ms'))).toBeGreaterThanOrEqual(0);
  });

  it('limiter が落ちても通常の check を続ける', async () => {
    // 監視の入口なので、limiter 障害では止めない（fail-open）。
    mocks.healthLimit.mockRejectedValueOnce(new Error('redis unavailable'));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Health-Check-Replayed')).toBeNull();
    expect(mocks.createClient).toHaveBeenCalled();
  });
});

function stubPreviewOperationalEnvironment(): void {
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('VERCEL_TARGET_ENV', 'preview');
  vi.stubEnv('VERCEL_BRANCH_URL', 'product-git-codex-mcp-preview-dayopt.vercel.app');
  vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'codex/mcp-preview');
  vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'preview');
  vi.stubEnv('MCP_OAUTH_PREVIEW_BRANCH', 'codex/mcp-preview');
  vi.stubEnv(
    'OAUTH_AUTHORIZATION_SERVER_URI',
    'https://product-git-codex-mcp-preview-dayopt.vercel.app',
  );
  vi.stubEnv(
    'MCP_CANONICAL_RESOURCE_URI',
    'https://product-git-codex-mcp-preview-dayopt.vercel.app',
  );
}

function createUnsignedTestJwt(payload: Record<string, string>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
