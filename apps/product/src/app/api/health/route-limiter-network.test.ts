/** V-13: SDKのEVALSHA / NOSCRIPT時のEVALと、probe通信をまとめて観測する。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://health-test.supabase.co' } }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('VERCEL_TARGET_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://health-test.supabase.co');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'health-test-key');
  vi.stubEnv('MCP_OAUTH_ENVIRONMENT', 'production');
  vi.stubEnv('OAUTH_AUTHORIZATION_SERVER_URI', 'https://app.dayopt.app');
  vi.stubEnv('MCP_CANONICAL_RESOURCE_URI', 'https://mcp.dayopt.app');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://health-redis.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-redis-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function network(options: { cold?: boolean; identityOk?: boolean } = {}) {
  const commands: string[] = [];
  let remaining = 119;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/rpc/get_mcp_environment_identity_v1')) {
      commands.push('identity');
      return options.identityOk === false
        ? Response.json({ message: 'db unavailable' }, { status: 400 })
        : Response.json([
            {
              environment: 'production',
              authorization_server_uri: 'https://app.dayopt.app',
              resource_uri: 'https://mcp.dayopt.app',
              supabase_project_ref: null,
              provisioned_at: '2026-01-01T00:00:00Z',
            },
          ]);
    }
    if (url.includes('/profiles?')) {
      commands.push('profiles');
      return Response.json([]);
    }
    if (url.startsWith('https://health-redis.upstash.io')) {
      const body: unknown = JSON.parse(String(init?.body));
      const pipeline = url.endsWith('/pipeline');
      const items: unknown[] = pipeline && Array.isArray(body) ? body : [body];
      const results = items.map((item) => {
        if (!Array.isArray(item) || typeof item[0] !== 'string') {
          throw new Error('Unexpected Redis command shape');
        }
        const command = item[0].toUpperCase();
        commands.push(command);
        if (command === 'PING') return { result: 'UE9ORw==' };
        if (command === 'EVALSHA' && options.cold) return { error: 'NOSCRIPT No matching script' };
        if (command === 'EVALSHA' || command === 'EVAL') return { result: [remaining, 120] };
        throw new Error('Unexpected Redis command');
      });
      return Response.json(pipeline ? results : results[0]);
    }
    throw new Error('Unexpected outbound health request');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    commands,
    fetchMock,
    exhaust: () => {
      remaining = -1;
    },
  };
}

describe('health probes including real limiter SDK traffic', () => {
  it('warm script: one EVALSHA plus identity, profiles and PING', async () => {
    const { commands, fetchMock } = network();
    const { GET } = await import('./route');
    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(commands[0]).toBe('EVALSHA');
    expect(commands.toSorted()).toEqual(['EVALSHA', 'PING', 'identity', 'profiles']);
  });

  it('cold script: NOSCRIPT adds one EVAL fallback', async () => {
    const { commands, fetchMock } = network({ cold: true });
    const { GET } = await import('./route');
    expect((await GET()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(commands.slice(0, 2)).toEqual(['EVALSHA', 'EVAL']);
    expect(commands.toSorted()).toEqual(['EVAL', 'EVALSHA', 'PING', 'identity', 'profiles']);
  });

  it('database identity failure stops profiles; the parallel PING still runs', async () => {
    const { commands, fetchMock } = network({ identityOk: false });
    const { GET } = await import('./route');
    expect((await GET()).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(commands[0]).toBe('EVALSHA');
    expect(commands.toSorted()).toEqual(['EVALSHA', 'PING', 'identity']);
  });

  it('limited request replays the last result, then the SDK block cache avoids Redis too', async () => {
    const { commands, fetchMock, exhaust } = network();
    const { GET } = await import('./route');
    expect((await GET()).status).toBe(200);
    commands.length = 0;
    fetchMock.mockClear();
    exhaust();
    expect((await GET()).headers.get('X-Health-Check-Replayed')).toBe('true');
    expect(commands).toEqual(['EVALSHA']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    commands.length = 0;
    fetchMock.mockClear();
    expect((await GET()).headers.get('X-Health-Check-Replayed')).toBe('true');
    expect(commands).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
