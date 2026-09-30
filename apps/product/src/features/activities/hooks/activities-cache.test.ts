import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCQueryUtils, getQueryKey } from '@trpc/react-query';
import superjson from 'superjson';
import { expect, it, vi } from 'vitest';

import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/lib/trpc/root';

import { invalidateActivityCaches } from './activities-cache';

it('分類の変更後、表示中のレポートを再取得し、閉じた詳細も再取得対象にする', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: 'http://unused.invalid/trpc', transformer: superjson })],
  });
  const utils = createTRPCQueryUtils({ queryClient, client });
  const periodKey = getQueryKey(trpc.review.getReportPeriod, { anchorDate: '2026-09-29' }, 'query');
  const detailKey = getQueryKey(trpc.review.getReportActivityDetail, { activityId: 'a1' }, 'query');
  const unrelatedKey = getQueryKey(trpc.billing.getAccess, undefined, 'query');
  const oldReport = { activityName: '変更前', categoryName: '仕事' };
  const changedReport = { activityName: '変更後', categoryName: null };
  queryClient.setQueryData(periodKey, oldReport);
  queryClient.setQueryData(detailKey, oldReport);
  queryClient.setQueryData(unrelatedKey, { status: 'active' });
  // 実際の TanStack Query と tRPC の query key/utility を使う。取得結果だけを合成する。
  const fetchReport = vi.fn().mockResolvedValue(changedReport);
  const observer = new QueryObserver(queryClient, {
    queryKey: periodKey,
    queryFn: fetchReport,
    staleTime: 60_000,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().data).toEqual(oldReport);
    expect(fetchReport).not.toHaveBeenCalled();

    invalidateActivityCaches(utils);

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(changedReport));
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  } finally {
    unsubscribe();
    queryClient.clear();
  }
});
