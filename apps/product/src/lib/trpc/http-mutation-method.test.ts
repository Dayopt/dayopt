/** #2721 V-10: exercise the same real adapter/method override as the public route. */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';
import { createChainableMock, createMockContext } from '@/lib/test/trpc-test-helpers';

import { createTRPCRouter, protectedProcedure } from './procedures';

const write = vi.fn(() => 'written');
const router = createTRPCRouter({ write: protectedProcedure.mutation(write) });

function call(method: string, contentType?: string, origin = 'https://app.dayopt.app') {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    router,
    allowMethodOverride: true,
    req: new Request('https://app.dayopt.app/api/trpc/write', {
      method,
      headers: { origin, ...(contentType ? { 'content-type': contentType } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }),
    createContext: () =>
      createMockContext({
        userId: 'http-method-test',
        supabaseOverrides: {
          from: (() => createChainableMock({ fence_enabled: false })) as never,
        },
      }),
  });
}

beforeEach(() => {
  write.mockClear();
  resetWriteFenceCacheForTestsOnly();
});

describe('mutation HTTP methods', () => {
  it('authorized same-origin JSON POST executes the mutation', async () => {
    expect((await call('POST', 'application/json')).status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('GET cannot execute mutation even with allowMethodOverride enabled', async () => {
    expect((await call('GET')).status).toBe(405);
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded'])(
    'cross-origin simple %s POST cannot execute mutation',
    async (contentType) => {
      expect(
        (await call('POST', contentType, 'https://untrusted.example')).status,
      ).toBeGreaterThanOrEqual(400);
      expect(write).not.toHaveBeenCalled();
    },
  );
});
