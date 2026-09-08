import { describe, expect, it, vi } from 'vitest';
import { createAppQueryClient } from './query-client';
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
