'use client';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { trpc } from '@/lib/trpc/client';
import { resolveRollingCalendarDaysRange } from '../lib/rolling-calendar-range';

function millisecondsUntilNextCalendarDay(timezone: string): number {
  try {
    return Math.max(
      1_000,
      Date.parse(resolveRollingCalendarDaysRange(timezone).endAt) - Date.now() + 1_000,
    );
  } catch {
    // A malformed persisted timezone should not make this hook crash the entire calendar.
    return 60_000;
  }
}

export function useActivitySummary(activityId: string, enabled: boolean) {
  const timezone = useUserPreferences((state) => state.timezone);

  return trpc.activities.getActivitySummary.useQuery(
    { activityId, timezone },
    {
      enabled,
      staleTime: 60_000,
      refetchInterval: () => millisecondsUntilNextCalendarDay(timezone),
    },
  );
}
