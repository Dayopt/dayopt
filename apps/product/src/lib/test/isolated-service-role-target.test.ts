import { describe, expect, it } from 'vitest';

import { resolveIsolatedServiceRoleTarget } from './isolated-service-role-target';

describe('isolated service role target', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321'])(
    'accepts only a configured loopback target: %s',
    (url) =>
      expect(resolveIsolatedServiceRoleTarget(url, 'local-secret', {})).toEqual({ safe: true }),
  );

  it.each([
    ['https://aaaaaaaaaaaaaaaaaaaa.supabase.co', {}],
    ['https://yvglwblxrnrenfifsnje.supabase.co', {}],
    ['http://127.0.0.1:54321', { E2E_ALLOW_NONLOCAL_SUPABASE: '1' }],
    ['http://127.0.0.1:54321', { E2E_PREVIEW_ORIGIN: 'https://product-abc-dayopt.vercel.app' }],
    ['http://127.0.0.1:54321', { E2E_PREVIEW_CLOUD_INTENT: '1' }],
    ['http://user:password@127.0.0.1:54321', {}],
    ['http://127.0.0.1:54321/path', {}],
  ])('rejects shared or ambiguous configuration: %s', (url, env) => {
    expect(resolveIsolatedServiceRoleTarget(url, 'local-secret', env).safe).toBe(false);
  });

  it('rejects missing credentials', () => {
    expect(resolveIsolatedServiceRoleTarget(undefined, undefined, {}).safe).toBe(false);
  });

  it('accepts an explicit disabled Cloud intent without widening nonlocal access', () => {
    expect(
      resolveIsolatedServiceRoleTarget('http://127.0.0.1:54321', 'local-secret', {
        E2E_PREVIEW_CLOUD_INTENT: '0',
        E2E_ALLOW_NONLOCAL_SUPABASE: '0',
      }),
    ).toEqual({ safe: true });
    expect(
      resolveIsolatedServiceRoleTarget('https://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'local-secret', {
        E2E_PREVIEW_CLOUD_INTENT: '0',
        E2E_ALLOW_NONLOCAL_SUPABASE: '0',
      }).safe,
    ).toBe(false);
  });
});
