import { afterEach, describe, expect, it, vi } from 'vitest';

import { fulfillTrpcProcedure } from './e2e/trpc-response-mock';

const ORIGIN = 'https://product-abc123-dayopt.vercel.app';
afterEach(() => vi.unstubAllEnvs());

function routeFor(origin = ORIGIN) {
  const response = { json: async () => [{ result: { data: {} } }, { result: { data: {} } }] };
  return {
    request: () => ({
      url: () => `${origin}/api/trpc/userSettings.get,billing.getOverview?batch=1`,
      headers: () => ({
        authorization: 'synthetic-user-token',
        'x-vercel-protection-bypass': 'stale-secret',
        'x-vercel-set-bypass-cookie': 'true',
      }),
    }),
    fetch: vi.fn(async () => response),
    fulfill: vi.fn(async () => {}),
  };
}

describe('Preview billing batch mock boundary', () => {
  it('fetches the real composition with pinned bypass headers and no automatic redirects', async () => {
    vi.stubEnv('E2E_PREVIEW_ORIGIN', ORIGIN);
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'synthetic-bypass');
    const route = routeFor();
    await fulfillTrpcProcedure(route as never, 'billing.getOverview', { synthetic: true });
    expect(route.fetch).toHaveBeenCalledWith({
      maxRedirects: 0,
      headers: {
        authorization: 'synthetic-user-token',
        'x-vercel-protection-bypass': 'synthetic-bypass',
      },
    });
    expect(route.fulfill).toHaveBeenCalledOnce();
  });

  it.each(['https://billing.stripe.com', 'https://other.example.com'])(
    'never forwards bypass or user credentials to %s',
    async (origin) => {
      vi.stubEnv('E2E_PREVIEW_ORIGIN', ORIGIN);
      vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'synthetic-bypass');
      const route = routeFor(origin);
      await expect(fulfillTrpcProcedure(route as never, 'billing.getOverview', {})).rejects.toThrow(
        'Preview batch mock target is invalid',
      );
      expect(route.fetch).not.toHaveBeenCalled();
    },
  );

  it('fails before fetching when the pinned bypass is missing', async () => {
    vi.stubEnv('E2E_PREVIEW_ORIGIN', ORIGIN);
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '');
    const route = routeFor();
    await expect(fulfillTrpcProcedure(route as never, 'billing.getOverview', {})).rejects.toThrow();
    expect(route.fetch).not.toHaveBeenCalled();
  });
});
