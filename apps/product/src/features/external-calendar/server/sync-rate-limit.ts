import 'server-only';

import {
  isSupabaseRateLimitPocEnabled,
  type SupabaseRateLimitPocClient,
} from '@/lib/rate-limit/supabase-poc';
import { calendarSyncNowRateLimit, hashRateLimitIdentifier } from '@/lib/rate-limit/upstash';

const CALENDAR_SYNC_NOW_LIMIT_COUNT = 6;
const CALENDAR_SYNC_NOW_WINDOW_SECONDS = 60 * 60;

/**
 * The POC can only be selected by an explicit flag on the fixed Integration deployment.
 * Preview deployments may share its database, so the database URL alone is not sufficient.
 */
export function isSupabaseCalendarSyncRateLimitPocEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return isSupabaseRateLimitPocEnabled(environment);
}

/**
 * Check the manual Calendar sync budget.
 *
 * An opted-in Integration deployment uses the atomic Supabase RPC. Any RPC failure propagates
 * to the router, which returns SERVICE_UNAVAILABLE before calling the Google sync service.
 * Production and all non-Integration deployments keep using the existing Upstash limiter.
 */
export async function checkCalendarSyncNowRateLimit(userId: string): Promise<boolean> {
  if (isSupabaseRateLimitPocEnabled()) {
    const [{ createServiceRoleClient }, { checkSupabaseRateLimitPoc }] = await Promise.all([
      import('@/lib/supabase/oauth'),
      import('@/lib/rate-limit/supabase-poc'),
    ]);
    const identifierHash = await hashRateLimitIdentifier(userId);
    const client = createServiceRoleClient();
    const decision = await checkSupabaseRateLimitPoc(
      client as unknown as SupabaseRateLimitPocClient,
      {
        scope: 'calendar-sync-now',
        identifierHash,
        limitCount: CALENDAR_SYNC_NOW_LIMIT_COUNT,
        windowSeconds: CALENDAR_SYNC_NOW_WINDOW_SECONDS,
      },
    );
    return decision.allowed;
  }

  if (!calendarSyncNowRateLimit) return true;
  return (await calendarSyncNowRateLimit.limit(userId)).success;
}
