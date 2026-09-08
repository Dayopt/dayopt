import 'server-only';

import { appTrialDurationMs, resolveBillingAccess, type BillingAccess } from '@dayopt/billing';
import type { SupabaseClient } from '@supabase/supabase-js';

import { trackBillingEvent } from '@/lib/analytics/billing-events';
import type { Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { ServiceError } from '@/lib/trpc/errors';

import { isBillingEnforced } from './enforcement-flag';

const ACCESS_COLUMNS =
  'subscription_status, app_trial_started_at, app_trial_ends_at, app_trial_consumed_at' as const;

export async function getBillingAccess(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<BillingAccess> {
  if (!isBillingEnforced()) {
    return { state: 'not_started', canUseProduct: true, trialEndsAt: null, enforced: false };
  }
  const { data, error } = await db
    .from('profiles')
    .select(ACCESS_COLUMNS)
    .eq('id', userId)
    .single();
  if (error) {
    const cause = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'read_access',
    });
    throw new ServiceError('INTERNAL_ERROR', 'Unable to verify access', { cause });
  }
  if (!data) throw new ServiceError('INTERNAL_ERROR', 'Unable to verify access');
  return resolveBillingAccess(data, Date.now(), true);
}

/** Only called from the authenticated app initialization mutation, never a query or cron. */
export async function startAppTrial(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<BillingAccess> {
  if (!isBillingEnforced()) return getBillingAccess(db, userId);
  const startedAt = Date.now();
  const { data, error } = await db
    .from('profiles')
    .update({
      app_trial_started_at: new Date(startedAt).toISOString(),
      app_trial_ends_at: new Date(startedAt + appTrialDurationMs).toISOString(),
    })
    .eq('id', userId)
    .in('subscription_status', ['free', 'canceled'])
    .is('app_trial_started_at', null)
    .is('app_trial_consumed_at', null)
    .select('id');
  if (error) {
    const cause = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'start_trial',
    });
    throw new ServiceError('INTERNAL_ERROR', 'Unable to start trial', { cause });
  }
  if (data?.length)
    await trackBillingEvent({
      eventName: 'app_trial_started',
      sourceId: userId,
      userId,
      occurredAt: new Date(startedAt).toISOString(),
    });
  return getBillingAccess(db, userId);
}
