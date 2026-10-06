import { QueryClient } from '@tanstack/react-query';
import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { afterEach, expect, it, vi } from 'vitest';

import { createAppTrpcClient } from './browser-client';

vi.mock('@/lib/trpc', async () => {
  const { createTRPCReact } = await import('@trpc/react-query');
  return { api: createTRPCReact(), getBaseUrl: () => 'http://localhost' };
});

afterEach(() => vi.unstubAllGlobals());

it('pending stats cannot hold range batches; POST, auth, superjson and shared-query dedup survive', async () => {
  let releaseStats!: () => void;
  const statsGate = new Promise<void>((resolve) => {
    releaseStats = resolve;
  });
  const t = initTRPC.create({ transformer: superjson });
  const statsProcedure = vi.fn(async () => {
    await statsGate;
    return { medianMinutes: { activity: 45 } };
  });
  const date = new Date('2026-09-15T00:00:00Z');
  const router = t.router({
    statistics: t.router({ getActivityStats: t.procedure.query(statsProcedure) }),
    plans: t.router({ list: t.procedure.query(() => ({ date })) }),
    records: t.router({ list: t.procedure.query(() => ({ date })) }),
  });
  const requests: Request[] = [];
  vi.stubGlobal('localStorage', { getItem: () => 'fixture-token' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    requests.push(req);
    return fetchRequestHandler({
      endpoint: '/api/trpc',
      req,
      router,
      allowMethodOverride: true,
      createContext: () => ({}),
    });
  });
  const client = createAppTrpcClient();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = {
    queryKey: ['shared-stats'],
    queryFn: () => client.statistics.getActivityStats.query(),
  };
  const stats = cache.fetchQuery(options);
  const sharedStats = cache.fetchQuery(options);
  let rangeReady = false;
  const range = Promise.all([client.plans.list.query(), client.records.list.query()]).then(
    (data) => {
      rangeReady = true;
      return data;
    },
  );
  try {
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    // A bounded wait detects the original batch head-of-line blocking without hanging the suite.
    await vi.waitFor(() => expect(rangeReady).toBe(true), { timeout: 500 });
    expect(requests).toHaveLength(2);
    expect(requests.map((req) => new URL(req.url).pathname).sort()).toEqual([
      '/api/trpc/plans.list,records.list',
      '/api/trpc/statistics.getActivityStats',
    ]);
    for (const req of requests) {
      expect(req.method).toBe('POST');
      expect(req.headers.get('authorization')).toBe('Bearer fixture-token');
      expect(new URL(req.url).searchParams.has('input')).toBe(false);
    }
    expect(await range).toEqual([{ date }, { date }]);
  } finally {
    releaseStats();
    await Promise.all([stats, sharedStats, range]);
    cache.clear();
  }
  expect(statsProcedure).toHaveBeenCalledTimes(1);
});
