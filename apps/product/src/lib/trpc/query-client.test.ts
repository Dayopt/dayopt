import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';
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
