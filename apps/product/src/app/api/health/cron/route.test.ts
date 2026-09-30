import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  select: vi.fn(),
  in: vi.fn(),
  heartbeatQuery: vi.fn(),
  identityQuery: vi.fn(),
  assertIdentity: vi.fn(),
  rateLimit: vi.fn(),
  loggerError: vi.fn(),
  rows: [] as Array<{ job_name: string; last_completed_at: string | null }>,
  queryError: null as unknown,
}));

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock('@/lib/oauth-server/database-identity', () => ({
  assertDatabaseOAuthIdentity: mocks.assertIdentity,
  resolveDatabaseOAuthProjectRef: () => null,
}));
vi.mock('@/lib/oauth-server/identity-env', () => ({
  getOAuthEnvironmentConfig: () => ({
    environment: 'production',
    authorizationServerUri: 'https://app.dayopt.app',
    resourceUri: 'https://mcp.dayopt.app',
  }),
}));
vi.mock('@/lib/rate-limit/upstash', () => ({
  cronHeartbeatHealthRateLimit: { limit: mocks.rateLimit },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: mocks.loggerError } }));

import { JOB_MAX_AGE_MINUTES } from '@/lib/ops/cron-heartbeat-policy.mjs';

function freshRows() {
  return Object.keys(JOB_MAX_AGE_MINUTES).map((job_name) => ({
    job_name,
    last_completed_at: new Date(Date.now() - 30_000).toISOString(),
  }));
}

async function getRoute() {
  return (await import('./route')).GET;
}

describe('GET /api/health/cron', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    mocks.rows = freshRows();
    mocks.queryError = null;
    mocks.rateLimit.mockResolvedValue({ success: true });
    mocks.assertIdentity.mockResolvedValue(undefined);
    mocks.heartbeatQuery.mockImplementation(async () => ({
      data: mocks.rows,
      error: mocks.queryError,
    }));
    mocks.identityQuery.mockResolvedValue({ data: [], error: null });
    mocks.select.mockReturnValue({ in: mocks.in });
    mocks.in.mockReturnValue({ abortSignal: mocks.heartbeatQuery });
    mocks.rpc.mockReturnValue({ abortSignal: mocks.identityQuery });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.createServiceRoleClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('productionでは許可リストのheartbeatだけを読み、statusのみをno-storeで返す', async () => {
    const GET = await getRoute();
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy' });
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(mocks.assertIdentity).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledWith('cron_heartbeats');
    expect(mocks.select).toHaveBeenCalledWith('job_name,last_completed_at');
    expect(mocks.in).toHaveBeenCalledWith('job_name', Object.keys(JOB_MAX_AGE_MINUTES));
  });

  it('stale heartbeat is unhealthy and does not disclose the failed job or timestamp', async () => {
    mocks.rows[0] = {
      ...mocks.rows[0]!,
      last_completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    const GET = await getRoute();
    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"status":"unhealthy"}');
    expect(body).not.toContain(mocks.rows[0]!.job_name);
    expect(body).not.toContain(mocks.rows[0]!.last_completed_at ?? '');
  });

  it('database identity mismatch stops the table query and fails closed', async () => {
    mocks.assertIdentity.mockRejectedValue(new Error('identity mismatch'));
    const GET = await getRoute();
    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('rate limit replays the last healthy or unhealthy status without querying again', async () => {
    const GET = await getRoute();
    expect((await GET()).status).toBe(200);
    mocks.heartbeatQuery.mockClear();
    mocks.rateLimit.mockResolvedValueOnce({ success: false });

    const replay = await GET();
    expect(replay.status).toBe(200);
    expect(replay.headers.get('X-Health-Check-Replayed')).toBe('true');
    expect(await replay.json()).toEqual({ status: 'healthy' });
    expect(mocks.heartbeatQuery).not.toHaveBeenCalled();
  });

  it('rate limiter failure does not prevent the database check', async () => {
    mocks.rateLimit.mockRejectedValue(new Error('limiter unavailable'));
    const GET = await getRoute();

    expect((await GET()).status).toBe(200);
    expect(mocks.heartbeatQuery).toHaveBeenCalledOnce();
  });

  it('non-production deployment cannot use the monitoring endpoint', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const GET = await getRoute();

    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});
