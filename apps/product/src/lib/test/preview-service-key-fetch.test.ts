import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdminSupabase } from './e2e/critical-path-fixture';
import { previewServiceKeyFetch } from './preview-service-key-fetch.mjs';

const KEY = 'sb_secret_SYNTHETIC_TEST_ONLY';
const TEST_URL = 'https://offline.invalid/rest/v1/profiles';

describe('Preview service key fetch', () => {
  it.each([
    [`Bearer ${KEY}`, null],
    ['Bearer user-session-jwt', 'Bearer user-session-jwt'],
    ['Bearer sb_secret_ANOTHER_SYNTHETIC_KEY', 'Bearer sb_secret_ANOTHER_SYNTHETIC_KEY'],
    [null, null],
  ])('removes only its own modern key fallback (%s)', async (authorization, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const headers = new Headers({ apikey: KEY, 'x-fixture': 'preserved' });
    if (authorization) headers.set('Authorization', authorization);
    const signal = new AbortController().signal;
    const init = { method: 'POST', body: '{}', headers, signal };
    await previewServiceKeyFetch(KEY, fetchImpl)(TEST_URL, init);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, forwarded] = fetchImpl.mock.calls[0]!;
    expect(input).toBe(TEST_URL);
    expect(forwarded).toMatchObject({ method: 'POST', body: '{}', signal });
    const actual = new Headers(forwarded?.headers);
    expect(actual.get('authorization')).toBe(expected);
    expect(actual.get('apikey')).toBe(KEY);
    expect(actual.get('x-fixture')).toBe('preserved');
    expect(headers.get('authorization')).toBe(authorization);
  });

  it('preserves Request headers without mutating the original request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const request = new Request(TEST_URL, {
      method: 'POST',
      body: '{}',
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'x-fixture': 'request' },
    });
    await previewServiceKeyFetch(KEY, fetchImpl)(request);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(input).toBe(request);
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('apikey')).toBe(KEY);
    expect(new Headers(init?.headers).get('x-fixture')).toBe('request');
    expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(request.bodyUsed).toBe(false);
  });

  it('honors RequestInit header overrides without restoring Request authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const request = new Request(TEST_URL, { headers: { authorization: `Bearer ${KEY}` } });
    await previewServiceKeyFetch(KEY, fetchImpl)(request, {
      headers: { apikey: KEY, authorization: 'Bearer user-session-jwt' },
    });
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer user-session-jwt',
    );
  });

  it('leaves legacy requests unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const legacy = 'synthetic-legacy-jwt';
    const init = { headers: { apikey: legacy, authorization: `Bearer ${legacy}` } };
    await previewServiceKeyFetch(legacy, fetchImpl)(TEST_URL, init);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(TEST_URL, init);
    expect(fetchImpl.mock.calls[0]![1]).toBe(init);
  });
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MODERN_KEY = KEY;
const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake';

afterEach(() => vi.unstubAllGlobals());

describe('critical path fixture SDK admin requests', () => {
  it.each([
    ['modern', MODERN_KEY, null],
    ['legacy', LEGACY_KEY, `Bearer ${LEGACY_KEY}`],
  ] as const)(
    'preserves apikey and the correct %s Authorization behavior',
    async (_kind, key, authorization) => {
      const requests: { path: string; method: string; headers: Headers }[] = [];
      // Capture the real SDK requests without delegating to the network.
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requests.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(path.startsWith('/auth/') ? { id: USER_ID } : []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const admin = createAdminSupabase('https://offline.invalid', key);
      await admin.auth.admin.createUser({ email: 'offline@example.invalid', email_confirm: true });
      await admin.auth.admin.getUserById(USER_ID);
      await admin.auth.admin.deleteUser(USER_ID);
      await admin.from('profiles').insert({ id: USER_ID, email: 'offline@example.invalid' });

      expect(requests.map(({ path, method }) => [path, method])).toEqual([
        ['/auth/v1/admin/users', 'POST'],
        [`/auth/v1/admin/users/${USER_ID}`, 'GET'],
        [`/auth/v1/admin/users/${USER_ID}`, 'DELETE'],
        ['/rest/v1/profiles', 'POST'],
      ]);
      for (const request of requests) {
        expect(request.headers.get('apikey')).toBe(key);
        expect(request.headers.get('authorization')).toBe(authorization);
      }
    },
  );
});
