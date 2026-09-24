import 'server-only';

import { createHash } from 'node:crypto';

import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

type BillingEventName =
  | 'app_trial_started'
  | 'subscription_payment_succeeded'
  | 'subscription_renewal_succeeded'
  | 'subscription_ended';

/** Stable primary key deduplicates provider redelivery without storing provider IDs. */
export function billingEventId(eventName: BillingEventName, sourceId: string): string {
  const hex = createHash('sha256').update(`${eventName}:${sourceId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function trackBillingEvent(input: {
  eventName: BillingEventName;
  sourceId: string;
  userId: string;
  occurredAt: string;
}): Promise<boolean> {
  try {
    const { error } = await createServiceRoleClient()
      .from('product_events')
      .insert({
        id: billingEventId(input.eventName, input.sourceId),
        event_name: input.eventName,
        user_id: input.userId,
        created_at: input.occurredAt,
        properties: {},
      })
      .abortSignal(AbortSignal.timeout(1_000));
    if (error && error.code !== '23505') {
      logger.warn('Billing analytics insert failed', { eventName: input.eventName });
      return false;
    }
    return true;
  } catch {
    logger.warn('Billing analytics unavailable', { eventName: input.eventName });
    return false;
  }
}

/** Returns whether another paid invoice has already been recorded for the account. */
export async function hasPriorPaidInvoiceEvent(input: {
  userId: string;
  invoiceId: string;
  currentEventName: 'subscription_payment_succeeded' | 'subscription_renewal_succeeded';
}): Promise<boolean> {
  try {
    const currentEventId = billingEventId(input.currentEventName, input.invoiceId);
    const query = createServiceRoleClient().rpc('has_prior_paid_invoice_event_v1', {
      p_user_id: input.userId,
      p_current_event_id: currentEventId,
    });
    const { data, error } = await query.abortSignal(AbortSignal.timeout(1_000));

    if (error) {
      logger.warn('Prior paid invoice lookup failed');
      return true;
    }
    return data === true;
  } catch {
    logger.warn('Prior paid invoice lookup failed');
    return true;
  }
}
