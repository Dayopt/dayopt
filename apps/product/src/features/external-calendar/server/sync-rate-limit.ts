import 'server-only';

import { calendarSyncNowRateLimit } from '@/lib/rate-limit/upstash';

/** POC retirement: existing opt-in flags cannot select the retired Supabase backend. */
export async function checkCalendarSyncNowRateLimit(userId: string): Promise<boolean> {
  if (!calendarSyncNowRateLimit) return true;
  return (await calendarSyncNowRateLimit.limit(userId)).success;
}
