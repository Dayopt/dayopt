import 'server-only';

import { databaseTables } from '@/lib/database';
import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

export const PRODUCT_EVENT_NAMES = [
  'user_signed_up',
  'plan_created',
  'record_created',
  'review_opened',
  'checkout_started',
  'subscription_started',
  'app_trial_started',
  'subscription_payment_succeeded',
  'subscription_renewal_succeeded',
  'subscription_ended',
] as const;

type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

interface ProductEventInput {
  eventName: ProductEventName;
  userId: string;
}

const PRODUCT_EVENT_INSERT_TIMEOUT_MS = 1_000;
const productEventNameSet = new Set<string>(PRODUCT_EVENT_NAMES);

export function isProductEventName(value: unknown): value is ProductEventName {
  return typeof value === 'string' && productEventNameSet.has(value);
}

function logTrackingFailure(eventNames: readonly ProductEventName[]): void {
  logger.warn('Product analytics event insert failed', {
    eventCount: eventNames.length,
    eventNames: [...new Set(eventNames)],
  });
}

/** Inserts one payload-free event without affecting the caller's primary operation. */
export async function trackProductEvent(event: ProductEventInput): Promise<void> {
  await trackProductEvents([event]);
}

/** Inserts a payload-free event batch in one request; failures are always swallowed. */
export async function trackProductEvents(events: readonly ProductEventInput[]): Promise<void> {
  if (events.length === 0) return;

  if (events.some((event) => !isProductEventName(event.eventName))) {
    logger.warn('Product analytics event rejected', { eventCount: events.length });
    return;
  }

  const eventNames = events.map((event) => event.eventName);

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase
      .from(databaseTables.productEvents)
      .insert(
        events.map((event) => ({
          event_name: event.eventName,
          properties: {},
          user_id: event.userId,
        })),
      )
      .abortSignal(AbortSignal.timeout(PRODUCT_EVENT_INSERT_TIMEOUT_MS));

    if (error) logTrackingFailure(eventNames);
  } catch {
    logTrackingFailure(eventNames);
  }
}
