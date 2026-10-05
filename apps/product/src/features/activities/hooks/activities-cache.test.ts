import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCQueryUtils, getQueryKey } from '@trpc/react-query';
import superjson from 'superjson';
import { expect, it, vi } from 'vitest';

import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/lib/trpc/root';

import { invalidateActivityCaches } from './activities-cache';

it('分類変更後にアクティビティ詳細のキャッシュを無効化する', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: 'http://unused.invalid/trpc', transformer: superjson })],
  });
  const utils = createTRPCQueryUtils({ queryClient, client });
  const summaryKey = getQueryKey(
    trpc.activities.getActivitySummary,
    { activityId: 'a1', timezone: 'UTC' },
    'query',
  );
  const unrelatedKey = getQueryKey(trpc.billing.getAccess, undefined, 'query');
  const oldSummary = { totalRecordCount: 1 };
  const changedSummary = { totalRecordCount: 2 };
  queryClient.setQueryData(summaryKey, oldSummary);
  queryClient.setQueryData(unrelatedKey, { status: 'active' });
  // 実際の TanStack Query と tRPC の query key/utility を使う。取得結果だけを合成する。
  const fetchSummary = vi.fn().mockResolvedValue(changedSummary);
  const observer = new QueryObserver(queryClient, {
    queryKey: summaryKey,
    queryFn: fetchSummary,
    staleTime: 60_000,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().data).toEqual(oldSummary);
    expect(fetchSummary).not.toHaveBeenCalled();

    invalidateActivityCaches(utils);

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(changedSummary));
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  } finally {
    unsubscribe();
    queryClient.clear();
  }
});
