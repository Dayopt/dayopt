import { collectQueryPages } from '@/lib/database/collect-query-pages';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { databaseTables, type Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import { clipMinutes, resolveRollingCalendarDaysRange } from '../lib/rolling-calendar-range';
import type { ActivitySummaryResult } from '../types/activity-summary';

const DETAIL_RECORD_LIMIT = 200;
const AUTO_MIGRATED_SOURCE = 'auto_migrated';

type ActivitySummaryClient = SupabaseClient<Database>;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const before = sorted[middle - 1];
  const after = sorted[middle];
  return before === undefined || after === undefined ? null : (before + after) / 2;
}

export function createActivitySummaryService(supabase: ActivitySummaryClient) {
  return {
    async getActivitySummary(
      userId: string,
      input: { activityId: string; timezone: string },
      now: Date = new Date(),
    ): Promise<ActivitySummaryResult> {
      const calendarRange = resolveRollingCalendarDaysRange(input.timezone, now);
      // Keep today's label while excluding records later than the captured server instant.
      const range = {
        ...calendarRange,
        endAt: new Date(Math.min(Date.parse(calendarRange.endAt), now.getTime())).toISOString(),
      };
      const query = supabase
        .from(databaseTables.records)
        .select('id, title, start_at, end_at, source')
        .eq('user_id', userId)
        .eq('activity_id', input.activityId)
        .is('deleted_at', null)
        .lt('start_at', range.endAt)
        .gt('end_at', range.startAt);
      const { data, error } = await collectQueryPages((from, to) =>
        query.order('id').range(from, to),
      );
      if (error) {
        throw captureUnexpectedDatabaseError(error, {
          feature: 'activities',
          operation: 'fetch_activity_summary_records',
        });
      }

      const inRange = data
        .map((row) => ({
          row,
          minutes: clipMinutes(row.start_at, row.end_at, range.startAt, range.endAt),
        }))
        .filter(({ minutes }) => minutes > 0);
      const medianMinutes = inRange
        .filter(({ row }) => row.source !== AUTO_MIGRATED_SOURCE)
        .map(({ minutes }) => minutes);

      return {
        startDate: calendarRange.startDate,
        endDate: calendarRange.endDate,
        recordedMinutes: inRange.reduce((total, row) => total + row.minutes, 0),
        medianBoxMinutes: median(medianMinutes),
        totalRecordCount: inRange.length,
        records: inRange
          .map(({ row, minutes }) => ({
            id: row.id,
            title: row.title,
            startAt: row.start_at,
            endAt: row.end_at,
            minutes,
            source: row.source,
          }))
          .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
          .slice(0, DETAIL_RECORD_LIMIT),
      };
    },
  };
}
