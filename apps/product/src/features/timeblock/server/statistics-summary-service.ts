import 'server-only';
import { aggregate, overlappingRecords, toDerivedBlock } from '../domain/derived-model';

/**
 * 統計 service — Summary: streak / KPI サマリー
 */

import { formatInTimeZone } from 'date-fns-tz';

import { getUserTimezone } from '@/lib/server/user-timezone-cache';

import { fetchPlans, fetchRecords } from './statistics-fetchers';
import type { BlankRateInput } from './statistics-kpi-service';
import { transformStatsOverviewResponse } from './statistics-overview-transform';
import { computeBlankRate, computeContextSwitches } from './statistics-service-grouping';
import type { ServiceSupabaseClient } from './types';

export class StatisticsSummaryService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  /** `get_active_dates` 相当。実績（records）が存在する日付（tz basis）の一覧。 */
  async getActiveDates(userId: string, startDate: string): Promise<string[]> {
    const timezone = await getUserTimezone(this.supabase, userId);
    const records = await fetchRecords(this.supabase, userId, { startDate });
    const days = new Set(
      records.map((record) => formatInTimeZone(new Date(record.start_at), timezone, 'yyyy-MM-dd')),
    );
    return Array.from(days).sort();
  }

  /** `get_stats_kpi_summary` 相当。 */
  async getStatsOverview(
    userId: string,
    { startDate, endDate, wakeHour, sleepHour }: BlankRateInput,
  ) {
    const timezone = await getUserTimezone(this.supabase, userId);
    const [records, plans] = await Promise.all([
      fetchRecords(this.supabase, userId, { startDate, endDate }),
      fetchPlans(this.supabase, userId, { startDate, endDate }),
    ]);

    const blocks = [
      ...plans.map((row) => toDerivedBlock(row, 'plan')),
      ...records.map((row) => toDerivedBlock(row, 'rec')),
    ];
    const overlappingIds = new Set(
      plans.flatMap((plan) =>
        overlappingRecords(toDerivedBlock(plan, 'plan'), blocks, new Date()).map(
          (record) => record.id,
        ),
      ),
    );
    const plannedEntries = overlappingIds.size;
    const contextSwitches = computeContextSwitches(records, timezone);
    const now = new Date();
    const totals = aggregate(
      {
        startAt: startDate ?? '1970-01-01T00:00:00Z',
        endAt:
          endDate ??
          new Date(
            Math.max(now.getTime(), ...blocks.map((block) => Date.parse(block.end))),
          ).toISOString(),
        timezone,
      },
      null,
      blocks.map((block) => ({ ...block, activityId: null })),
      now,
    );
    const scheduledMinutes = totals.plannedMinutes;
    const cumulativeMinutes = totals.recordedMinutes;
    const blankRate = computeBlankRate(scheduledMinutes, {
      startDate,
      endDate,
      wakeHour,
      sleepHour,
    });

    return transformStatsOverviewResponse({
      cumulativeTime: { totalMinutes: cumulativeMinutes },
      planRate: {
        totalEntries: records.length,
        plannedEntries,
        planRate:
          totals.plannedPastMinutes >= 15
            ? totals.recordedMinutes / totals.plannedPastMinutes
            : null,
      },
      contextSwitches,
      blankRate,
    });
  }
}
