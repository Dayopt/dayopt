/** V-13: real DB/Redis clients, fetch intercepted before any external communication. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('@/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://health-test.supabase.co' } }));
// The limiter's Redis EVAL traffic is covered separately; count the downstream health probes here.
vi.mock('@/lib/rate-limit/upstash', () => ({ healthCheckGlobalRateLimit: null }));

beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('VERCEL_TARGET_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://health-test.supabase.co');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'health-test-key');
  vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'production');
  vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app');
  vi.stubEnv('MCP_CANONICAL_RESOURCE_URI', 'https://mcp.dayopt.app');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function network(identityOk = true) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/rpc/get_mcp_environment_identity_v1')) {
      return identityOk
        ? Response.json([
            {
              environment: 'production',
              authorization_server_uri: 'https://app.dayopt.app',
              resource_uri: 'https://mcp.dayopt.app',
              supabase_project_ref: null,
              provisioned_at: '2026-01-01T00:00:00Z',
            },
          ])
        : Response.json({ message: 'db unavailable' }, { status: 400 });
    }
    if (url.includes('/profiles?')) return Response.json([]);
    if (url.startsWith('https://health-redis.upstash.io')) {
      return Response.json(
        url.endsWith('/pipeline') ? [{ result: 'UE9ORw==' }] : { result: 'UE9ORw==' },
      );
    }
    throw new Error('Unexpected health probe');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('health probe outbound counts', () => {
  it('missing Redis does not contact Redis; identity and profiles make two requests', async () => {
    const fetchMock = network();
    const response = await GET();
    expect(response.status).toBe(503); // Operational Redis is missing, while DB probes still run.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('identity failure stops profiles query', async () => {
    const fetchMock = network(false);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rpc/get_mcp_environment_identity_v1');
  });
  it('configured Redis adds one PING to the two database probes', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://health-redis.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-redis-token');
    const fetchMock = network();
    const response = await GET();
    expect(
      response.status,
      JSON.stringify(
        fetchMock.mock.calls.map(([input]) =>
          input instanceof Request ? input.url : String(input),
        ),
      ),
    ).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
