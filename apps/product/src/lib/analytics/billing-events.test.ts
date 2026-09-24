import { beforeEach, describe, expect, it, vi } from 'vitest';
import { billingEventId, hasPriorPaidInvoiceEvent, trackBillingEvent } from './billing-events';
const abortSignal = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn(() => ({ abortSignal })));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({ from: () => ({ insert }), rpc }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
const input = {
  eventName: 'subscription_payment_succeeded',
  sourceId: 'in_test',
  userId: 'user-1',
  occurredAt: '2026-09-08T00:00:00Z',
} as const;
describe('trusted billing analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('deduplicates a redelivered invoice and separates renewals', async () => {
    abortSignal
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: '23505' } });
    expect(await trackBillingEvent(input)).toBe(true);
    expect(await trackBillingEvent(input)).toBe(true);
    expect(insert.mock.calls[0]).toEqual(insert.mock.calls[1]);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: billingEventId(input.eventName, input.sourceId),
        created_at: input.occurredAt,
        properties: {},
      }),
    );
    expect(billingEventId('subscription_renewal_succeeded', input.sourceId)).not.toBe(
      billingEventId(input.eventName, input.sourceId),
    );
  });
  it('reports persistence failure so the webhook can retry', async () => {
    abortSignal
      .mockResolvedValueOnce({ error: { code: '08006' } })
      .mockRejectedValueOnce(new Error('timeout'));
    expect(await trackBillingEvent(input)).toBe(false);
    expect(await trackBillingEvent(input)).toBe(false);
  });

  it('uses the narrow server RPC to look up prior paid invoice events', async () => {
    const abort = vi.fn().mockResolvedValue({ data: false, error: null });
    rpc.mockReturnValueOnce({ abortSignal: abort });

    await expect(
      hasPriorPaidInvoiceEvent({
        userId: input.userId,
        invoiceId: input.sourceId,
        currentEventName: 'subscription_payment_succeeded',
      }),
    ).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith('has_prior_paid_invoice_event_v1', {
      p_user_id: input.userId,
      p_current_event_id: billingEventId(input.eventName, input.sourceId),
    });
    expect(abort).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
});
