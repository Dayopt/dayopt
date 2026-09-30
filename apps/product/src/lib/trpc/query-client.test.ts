import { shouldPersistQuery } from '@/lib/tanstack-query/should-persist-query';
import { CancelledError, dehydrate, hydrate, QueryObserver } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';
import { captureUnexpectedTrpcClientFailure } from './client-errors';
import { createAppQueryClient } from './query-client';

function rateLimitedError(): TRPCClientError<never> {
  return new TRPCClientError('Too many requests', {
    result: {
      error: {
        message: 'Too many requests',
        code: -32029,
        data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
      },
    },
  } as never);
}
vi.mock('@/lib/trpc/client-errors', () => ({ captureUnexpectedTrpcClientFailure: vi.fn() }));
describe('access-ended mutation handling', () => {
  it('does not automatically resend rejected input and refreshes access', async () => {
    const client = createAppQueryClient();
    const refresh = vi.spyOn(client, 'invalidateQueries');
    const error = Object.assign(new Error('Access ended'), {
      data: { serviceCode: 'BILLING_ACCESS_ENDED' },
    });
    const mutationFn = vi.fn().mockRejectedValue(error);
    const mutation = client.getMutationCache().build(client, { mutationFn });
    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ queryKey: [['billing', 'getAccess']] });
    client.clear();
  });
});

describe('rate limit handling (#2669)', () => {
  it('does not retry a query rejected with TOO_MANY_REQUESTS', async () => {
    const client = createAppQueryClient();
    const error = rateLimitedError();
    const queryFn = vi.fn().mockRejectedValue(error);
    await expect(client.fetchQuery({ queryKey: ['rate-limited'], queryFn })).rejects.toBe(error);
    expect(queryFn).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('does not retry a mutation rejected with TOO_MANY_REQUESTS', async () => {
    const client = createAppQueryClient();
    const error = rateLimitedError();
    const mutationFn = vi.fn().mockRejectedValue(error);
    const mutation = client.getMutationCache().build(client, { mutationFn });
    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(mutationFn).toHaveBeenCalledTimes(1);
    client.clear();
  });
});

describe('local mutation cancellation', () => {
  it('does not resend or report intentionally cancelled input', async () => {
    vi.mocked(captureUnexpectedTrpcClientFailure).mockClear();
    const client = createAppQueryClient();
    const error = new CancelledError({ silent: true });
    const mutationFn = vi.fn().mockRejectedValue(error);
    const mutation = client.getMutationCache().build(client, { mutationFn });
    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(captureUnexpectedTrpcClientFailure).not.toHaveBeenCalled();
    client.clear();
  });
});

describe('billing overview after an external cancellation (#2867)', () => {
  it('refreshes an externally canceled contract when focus returns', async () => {
    const client = createAppQueryClient();
    const queryKey = [['billing', 'getOverview'], { type: 'query' }] as const;
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ status: 'active' })
      .mockResolvedValue({ status: 'canceled' });
    const observer = new QueryObserver(client, { queryKey, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('active'));
      client.getQueryCache().find({ queryKey })?.onFocus();
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('canceled'));
      expect(queryFn).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it('excludes current contracts from persistence while preserving ordinary data', async () => {
    const client = createAppQueryClient();
    try {
      await client.fetchQuery({
        queryKey: [['billing', 'getOverview'], { type: 'query' }],
        queryFn: async () => ({ billingInfo: { subscriptionStatus: 'active' } }),
      });
      client.setQueryData(['ordinary'], { name: 'saved' });
      const persisted = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery });
      expect(persisted.queries.map((query) => query.queryKey)).toEqual([['ordinary']]);
    } finally {
      client.clear();
    }
  });

  it('shares an in-flight refresh between simultaneous billing observers', async () => {
    const client = createAppQueryClient();
    const queryKey = [['billing', 'getOverview'], { type: 'query' }] as const;
    let complete!: (value: { subscriptionStatus: string }) => void;
    const response = new Promise<{ subscriptionStatus: string }>((resolve) => {
      complete = resolve;
    });
    const queryFn = vi.fn(() => response);
    const first = new QueryObserver(client, { queryKey, queryFn });
    const second = new QueryObserver(client, { queryKey, queryFn });
    const stopFirst = first.subscribe(() => {});
    const stopSecond = second.subscribe(() => {});
    try {
      complete({ subscriptionStatus: 'canceled' });
      await vi.waitFor(() => {
        expect(first.getCurrentResult().data?.subscriptionStatus).toBe('canceled');
        expect(second.getCurrentResult().data?.subscriptionStatus).toBe('canceled');
      });
      expect(queryFn).toHaveBeenCalledTimes(1);
    } finally {
      stopFirst();
      stopSecond();
      client.clear();
    }
  });

  it('refreshes a recently restored active contract on mount', async () => {
    const queryKey = [['billing', 'getOverview'], { type: 'query' }] as const;
    const previous = createAppQueryClient();
    previous.setQueryData(queryKey, { billingInfo: { subscriptionStatus: 'active' } });
    const client = createAppQueryClient();
    hydrate(client, dehydrate(previous));
    const queryFn = vi.fn().mockResolvedValue({
      billingInfo: { subscriptionStatus: 'canceled' },
    });
    const observer = new QueryObserver(client, { queryKey, queryFn, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().data?.billingInfo.subscriptionStatus).toBe('canceled');
      });
      expect(queryFn).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      previous.clear();
      client.clear();
    }
  });
});
