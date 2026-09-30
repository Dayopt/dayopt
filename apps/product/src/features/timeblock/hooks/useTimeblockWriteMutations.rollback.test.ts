import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({ api: {} }));

import {
  deleteTimeblockCacheRows,
  insertTimeModelRowIntoMatchingLists,
  restoreTimeblockLists,
  settleTimeblockCache,
  snapshotTimeblockLists,
  writeTimeblockCache,
} from './useTimeblockWriteMutations';

const plansKey = [['plans', 'list'], { type: 'query' }] as const;
const recordsKey = [['records', 'list'], { type: 'query' }] as const;
const detailKey = [['plans', 'getById'], { type: 'query', input: { id: 'b' } }] as const;

function row(id: string) {
  return {
    id,
    title: id,
    note: null,
    activity_id: null,
    start_at: '2026-09-01T09:00:00.000Z',
    end_at: '2026-09-01T10:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000001Z',
    deleted_at: null,
  };
}

const clients = new Set<QueryClient>();
afterEach(() => {
  for (const queryClient of clients) queryClient.clear();
  clients.clear();
});

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.add(queryClient);
  return queryClient;
}

// These execute the production snapshot/cache helpers with real QueryClient storage.
// A fails after an independent operation B has committed, before any eventual refetch.
describe('timeblock rollback isolation', () => {
  it.each(['plans', 'records'] as const)(
    'retains a committed %s creation when another creation fails',
    async (lane) => {
      const queryClient = client();
      queryClient.setQueryData(plansKey, []);
      queryClient.setQueryData(recordsKey, []);
      const context = await snapshotTimeblockLists(queryClient);
      writeTimeblockCache(queryClient, context, () =>
        insertTimeModelRowIntoMatchingLists(queryClient, 'plans', row('temp-a')),
      );
      const committed = await snapshotTimeblockLists(queryClient);
      writeTimeblockCache(queryClient, committed, () =>
        insertTimeModelRowIntoMatchingLists(queryClient, lane, row('committed-b')),
      );
      settleTimeblockCache(queryClient, committed);
      restoreTimeblockLists(queryClient, context);
      const key = lane === 'plans' ? plansKey : recordsKey;
      expect(queryClient.getQueryData(key)).toEqual([row('committed-b')]);
      expect(
        queryClient
          .getQueryData<ReturnType<typeof row>[]>(plansKey)
          ?.some((value) => value.id === 'temp-a'),
      ).toBe(false);
      queryClient.clear();
    },
  );

  it('does not resurrect a committed deletion when another deletion fails', async () => {
    const queryClient = client();
    queryClient.setQueryData(plansKey, [row('a'), row('b')]);
    const context = await snapshotTimeblockLists(queryClient);
    deleteTimeblockCacheRows(queryClient, context, 'plans', new Set(['a']));
    const deletion = await snapshotTimeblockLists(queryClient);
    deleteTimeblockCacheRows(queryClient, deletion, 'plans', new Set(['b']));
    settleTimeblockCache(queryClient, deletion);
    restoreTimeblockLists(queryClient, context);
    expect(queryClient.getQueryData(plansKey)).toEqual([row('a')]);
    queryClient.clear();
  });

  it('retains a refreshed unrelated Inspector row when an operation fails', async () => {
    const queryClient = client();
    queryClient.setQueryData(plansKey, [row('a')]);
    queryClient.setQueryData(detailKey, row('b'));
    const context = await snapshotTimeblockLists(queryClient);
    deleteTimeblockCacheRows(queryClient, context, 'plans', new Set(['a']));
    const refreshed = {
      ...row('b'),
      note: 'committed edit',
      updated_at: '2026-09-01T00:00:00.000002Z',
    };
    queryClient.setQueryData(detailKey, refreshed);
    restoreTimeblockLists(queryClient, context);
    expect(queryClient.getQueryData(detailKey)).toEqual(refreshed);
    queryClient.clear();
  });

  it('does not resurrect a deletion hidden by an optimistic limited-list displacement', async () => {
    const queryClient = client();
    const limitedKey = [['plans', 'list'], { type: 'query', input: { limit: 1 } }] as const;
    queryClient.setQueryData(limitedKey, [row('b')]);
    const context = await snapshotTimeblockLists(queryClient);
    writeTimeblockCache(queryClient, context, () =>
      insertTimeModelRowIntoMatchingLists(queryClient, 'plans', {
        ...row('temp-a'),
        start_at: '2026-09-01T08:00:00.000Z',
      }),
    );
    expect(queryClient.getQueryData(limitedKey)).toEqual([
      { ...row('temp-a'), start_at: '2026-09-01T08:00:00.000Z' },
    ]);
    // B can be deleted through a loaded Inspector even when displaced from this list.
    const deletion = await snapshotTimeblockLists(queryClient);
    deleteTimeblockCacheRows(queryClient, deletion, 'plans', new Set(['b']));
    settleTimeblockCache(queryClient, deletion);
    restoreTimeblockLists(queryClient, context);
    expect(queryClient.getQueryData(limitedKey)).toEqual([]);
    queryClient.clear();
  });

  it('returns the original row after overlapping same-resource updates both fail', async () => {
    const queryClient = client();
    const original = row('a');
    queryClient.setQueryData(plansKey, [original]);
    const first = await snapshotTimeblockLists(queryClient);
    const firstOptimistic = { ...original, title: 'failed title' };
    writeTimeblockCache(queryClient, first, () =>
      queryClient.setQueryData(plansKey, [firstOptimistic]),
    );
    const second = await snapshotTimeblockLists(queryClient);
    writeTimeblockCache(queryClient, second, () =>
      queryClient.setQueryData(plansKey, [{ ...firstOptimistic, note: 'failed note' }]),
    );
    restoreTimeblockLists(queryClient, first);
    restoreTimeblockLists(queryClient, second);
    expect(queryClient.getQueryData(plansKey)).toEqual([original]);
    queryClient.clear();
  });

  it('does not reintroduce an old cache after clear and recreation', async () => {
    const queryClient = client();
    queryClient.setQueryData(plansKey, [row('old-session')]);
    const context = await snapshotTimeblockLists(queryClient);
    queryClient.clear();
    queryClient.setQueryData(plansKey, []);
    restoreTimeblockLists(queryClient, context);
    expect(queryClient.getQueryData(plansKey)).toEqual([]);
    queryClient.clear();
  });
  it('removes a failed optimistic row from a query that had no data yet', async () => {
    const queryClient = client();
    queryClient.getQueryCache().build(queryClient, { queryKey: plansKey });
    const context = await snapshotTimeblockLists(queryClient);
    writeTimeblockCache(queryClient, context, () =>
      insertTimeModelRowIntoMatchingLists(queryClient, 'plans', row('temp-a')),
    );
    expect(queryClient.getQueryData(plansKey)).toEqual([row('temp-a')]);
    restoreTimeblockLists(queryClient, context);
    expect(queryClient.getQueryData(plansKey)).toBeUndefined();
  });
});
