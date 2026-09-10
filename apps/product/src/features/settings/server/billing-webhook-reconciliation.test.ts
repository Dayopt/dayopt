import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasBillingWebhookReconciliationDiscrepancy,
  reconcileBillingWebhookEventsWithDependencies,
} from './billing-webhook-reconciliation';

const NOW = Date.parse('2026-09-10T00:00:00.000Z');
const IDENTITY = { accountId: 'acct_dayopt_test', livemode: false } as const;

function event(id: string, type = 'checkout.session.completed') {
  return { id, livemode: false, type };
}

describe('billing webhook reconciliation', () => {
  const retrieveAccountId = vi.fn();
  const listEvents = vi.fn();
  const loadEventRows = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    retrieveAccountId.mockResolvedValue(IDENTITY.accountId);
    listEvents.mockResolvedValue({ data: [], hasMore: false });
    loadEventRows.mockResolvedValue([]);
  });

  it('missing・failed・stale processingを件数だけで検出する', async () => {
    listEvents.mockResolvedValue({
      data: [event('evt_missing'), event('evt_failed'), event('evt_stale'), event('evt_ok')],
      hasMore: false,
    });
    loadEventRows.mockResolvedValue([
      { event_id: 'evt_failed', status: 'failed', claimed_at: '2026-09-09T23:59:00.000Z' },
      { event_id: 'evt_stale', status: 'processing', claimed_at: '2026-09-09T23:54:00.000Z' },
      { event_id: 'evt_ok', status: 'processed', claimed_at: '2026-09-09T23:58:00.000Z' },
    ]);

    const summary = await reconcileBillingWebhookEventsWithDependencies(
      { listEvents, loadEventRows, retrieveAccountId },
      IDENTITY,
      NOW,
    );

    expect(summary).toEqual({
      checked: 4,
      failed: 1,
      invalidState: 0,
      missing: 1,
      staleProcessing: 1,
      truncated: false,
    });
    expect(hasBillingWebhookReconciliationDiscrepancy(summary)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('evt_');
    expect(listEvents).toHaveBeenCalledWith({
      createdGte: Math.floor(NOW / 1_000) - 26 * 60 * 60,
      createdLte: Math.floor(NOW / 1_000) - 5 * 60,
    });
  });

  it('未処理のirrelevant eventを集計しない', async () => {
    listEvents.mockResolvedValue({
      data: [event('evt_irrelevant', 'charge.refunded')],
      hasMore: false,
    });

    const summary = await reconcileBillingWebhookEventsWithDependencies(
      { listEvents, loadEventRows, retrieveAccountId },
      IDENTITY,
      NOW,
    );

    expect(summary.checked).toBe(0);
    expect(summary.missing).toBe(0);
    expect(loadEventRows).toHaveBeenCalledWith([]);
    expect(hasBillingWebhookReconciliationDiscrepancy(summary)).toBe(false);
  });

  it('provider accountまたはevent identityが違えばfail closedにする', async () => {
    retrieveAccountId.mockResolvedValueOnce('acct_other');
    await expect(
      reconcileBillingWebhookEventsWithDependencies(
        { listEvents, loadEventRows, retrieveAccountId },
        IDENTITY,
        NOW,
      ),
    ).rejects.toThrow('account identity mismatch');

    retrieveAccountId.mockResolvedValueOnce(IDENTITY.accountId);
    listEvents.mockResolvedValueOnce({
      data: [{ ...event('evt_live'), livemode: true }],
      hasMore: false,
    });
    await expect(
      reconcileBillingWebhookEventsWithDependencies(
        { listEvents, loadEventRows, retrieveAccountId },
        IDENTITY,
        NOW,
      ),
    ).rejects.toThrow('event identity mismatch');
  });

  it('4ページを超える時は打ち切りをdiscrepancyとして返す', async () => {
    listEvents.mockImplementation(async ({ startingAfter }: { startingAfter?: string }) => {
      const page = startingAfter ? Number(startingAfter.replace('evt_page_', '')) + 1 : 1;
      return { data: [event(`evt_page_${page}`)], hasMore: true };
    });
    loadEventRows.mockImplementation(async (eventIds: string[]) =>
      eventIds.map((eventId) => ({
        event_id: eventId,
        status: 'processed',
        claimed_at: '2026-09-09T23:58:00.000Z',
      })),
    );

    const summary = await reconcileBillingWebhookEventsWithDependencies(
      { listEvents, loadEventRows, retrieveAccountId },
      IDENTITY,
      NOW,
    );

    expect(listEvents).toHaveBeenCalledTimes(4);
    expect(summary.truncated).toBe(true);
    expect(hasBillingWebhookReconciliationDiscrepancy(summary)).toBe(true);
  });
});
