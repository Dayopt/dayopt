import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreviewAdmin } from './preview-e2e.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MODERN_KEY = 'sb_secret_SYNTHETIC_TEST_ONLY';
const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake';

afterEach(() => vi.unstubAllGlobals());

describe('manual recovery SDK admin requests', () => {
  it.each([
    ['modern', MODERN_KEY, null],
    ['legacy', LEGACY_KEY, `Bearer ${LEGACY_KEY}`],
  ] as const)(
    'preserves apikey and the correct %s Authorization behavior',
    async (_kind, key, authorization) => {
      const requests: { path: string; method: string; headers: Headers }[] = [];
      // Never delegate to real fetch, including for recovery's Supabase-shaped URL.
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requests.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(path.startsWith('/auth/') ? { id: USER_ID } : []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const admin = createPreviewAdmin('abcdefghijklmnopqrst', key);
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
