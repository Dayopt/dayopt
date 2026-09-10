import 'server-only';

import { requireStripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import {
  matchesStripeWebhookIdentity,
  type StripeWebhookIdentity,
} from '@/lib/stripe/webhook-identity';

// 日次cronの遅延と直近5分の処理猶予を両方吸収し、境界上のeventを取りこぼさない。
const RECONCILIATION_LOOKBACK_SECONDS = 26 * 60 * 60;
const RECENT_EVENT_GRACE_SECONDS = 5 * 60;
const STRIPE_REQUEST_TIMEOUT_MS = 5_000;
const DATABASE_REQUEST_TIMEOUT_MS = 3_000;
const MAX_EVENT_PAGES = 4;
const EVENTS_PER_PAGE = 100;
const STALE_PROCESSING_AFTER_MS = 5 * 60 * 1_000;

const RELEVANT_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

interface ReconciliationEvent {
  account?: string;
  id: string;
  livemode: boolean;
  type: string;
}

interface WebhookEventRow {
  claimed_at: string;
  event_id: string;
  status: string;
}

interface ReconciliationDependencies {
  listEvents: (input: {
    createdGte: number;
    createdLte: number;
    startingAfter?: string;
  }) => Promise<{ data: ReconciliationEvent[]; hasMore: boolean }>;
  loadEventRows: (eventIds: string[]) => Promise<WebhookEventRow[]>;
  retrieveAccountId: () => Promise<string>;
}

interface BillingWebhookReconciliationSummary {
  checked: number;
  failed: number;
  invalidState: number;
  missing: number;
  staleProcessing: number;
  truncated: boolean;
}

export function hasBillingWebhookReconciliationDiscrepancy(
  summary: BillingWebhookReconciliationSummary,
): boolean {
  return (
    summary.failed > 0 ||
    summary.invalidState > 0 ||
    summary.missing > 0 ||
    summary.staleProcessing > 0 ||
    summary.truncated
  );
}

/**
 * Stripe の直近イベントと webhook の durable state を照合する。
 * event/customer ID は summary に出さず、検出のみを行ってDBは変更しない。
 */
export async function reconcileBillingWebhookEventsWithDependencies(
  dependencies: ReconciliationDependencies,
  expectedIdentity: StripeWebhookIdentity,
  now = Date.now(),
): Promise<BillingWebhookReconciliationSummary> {
  const accountId = await dependencies.retrieveAccountId();
  if (accountId !== expectedIdentity.accountId) {
    throw new Error('Stripe reconciliation account identity mismatch');
  }

  const summary: BillingWebhookReconciliationSummary = {
    checked: 0,
    failed: 0,
    invalidState: 0,
    missing: 0,
    staleProcessing: 0,
    truncated: false,
  };
  const createdGte = Math.floor(now / 1_000) - RECONCILIATION_LOOKBACK_SECONDS;
  const createdLte = Math.floor(now / 1_000) - RECENT_EVENT_GRACE_SECONDS;
  const staleBefore = now - STALE_PROCESSING_AFTER_MS;
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const providerPage = await dependencies.listEvents({
      createdGte,
      createdLte,
      ...(startingAfter ? { startingAfter } : {}),
    });
    const relevantEvents = providerPage.data.filter((event) =>
      RELEVANT_EVENT_TYPES.has(event.type),
    );

    if (relevantEvents.some((event) => !matchesStripeWebhookIdentity(event, expectedIdentity))) {
      throw new Error('Stripe reconciliation event identity mismatch');
    }

    const rows = await dependencies.loadEventRows(relevantEvents.map((event) => event.id));
    const rowsByEventId = new Map(rows.map((row) => [row.event_id, row]));

    for (const event of relevantEvents) {
      summary.checked += 1;
      const row = rowsByEventId.get(event.id);
      if (!row) {
        summary.missing += 1;
      } else if (row.status === 'failed') {
        summary.failed += 1;
      } else if (row.status === 'processing' && Date.parse(row.claimed_at) <= staleBefore) {
        summary.staleProcessing += 1;
      } else if (row.status !== 'processing' && row.status !== 'processed') {
        summary.invalidState += 1;
      }
    }

    if (!providerPage.hasMore) break;
    const lastEvent = providerPage.data.at(-1);
    if (!lastEvent || page === MAX_EVENT_PAGES - 1) {
      summary.truncated = true;
      break;
    }
    startingAfter = lastEvent.id;
  }

  return summary;
}

export async function reconcileBillingWebhookEvents(
  expectedIdentity: StripeWebhookIdentity,
  now = Date.now(),
): Promise<BillingWebhookReconciliationSummary> {
  const stripe = requireStripe();
  const supabase = createServiceRoleClient();

  return reconcileBillingWebhookEventsWithDependencies(
    {
      async retrieveAccountId() {
        const account = await stripe.accounts.retrieve({
          maxNetworkRetries: 0,
          timeout: STRIPE_REQUEST_TIMEOUT_MS,
        });
        return account.id;
      },
      async listEvents({ createdGte, createdLte, startingAfter }) {
        const page = await stripe.events.list(
          {
            created: { gte: createdGte, lte: createdLte },
            limit: EVENTS_PER_PAGE,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          { maxNetworkRetries: 0, timeout: STRIPE_REQUEST_TIMEOUT_MS },
        );
        return { data: page.data, hasMore: page.has_more };
      },
      async loadEventRows(eventIds) {
        if (eventIds.length === 0) return [];
        const query = supabase
          .from('stripe_webhook_events')
          .select('event_id,status,claimed_at')
          .in('event_id', eventIds);
        const { data, error } = await query.abortSignal(
          AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS),
        );
        if (error) throw error;
        return data;
      },
    },
    expectedIdentity,
    now,
  );
}
