import 'server-only';
import { toDerivedBlock } from '../domain/derived-model';

/**
 * 統計 service — KPI: 見積もり精度・空白率
 */

import {
  aggregatePlanRecordEstimationAccuracy,
  type EstimationAccuracyActivityLookup,
  type EstimationAccuracyDbRow,
  transformEstimationAccuracy,
} from '../domain';

import type {
  ActivityLookupRow,
  CategoryLookupRow,
  DateRangeInput,
  StatPlanRow,
} from './statistics-fetchers';
import {
  fetchActivitiesById,
  fetchCategoriesById,
  fetchPlans,
  fetchRecords,
} from './statistics-fetchers';
import { computeBlankRate, minutesBetween } from './statistics-service-grouping';
import type { ServiceSupabaseClient } from './types';

export interface BlankRateInput extends DateRangeInput {
  wakeHour: number;
  sleepHour: number;
}

export class StatisticsKpiService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  /**
   * `get_estimation_accuracy` 相当。独立した予定と記録の期間合計比。
   * 詳細は `domain/estimation-accuracy.ts` の `aggregatePlanRecordEstimationAccuracy` を参照。
   */
  async getEstimationAccuracy(userId: string, range: DateRangeInput = {}) {
    const [plans, activitiesById, categoriesById] = await Promise.all([
      fetchPlans(this.supabase, userId, range),
      fetchActivitiesById(this.supabase, userId),
      fetchCategoriesById(this.supabase, userId),
    ]);
    const rows = await this.computeEstimationAccuracy(
      userId,
      plans,
      activitiesById,
      categoriesById,
      range,
    );
    return transformEstimationAccuracy(rows);
  }

  /** `get_blank_rate` 相当。予定（plans）ベースのスケジュール時間から空白率を算出する。 */
  async getBlankRate(userId: string, { startDate, endDate, wakeHour, sleepHour }: BlankRateInput) {
    const plans = await fetchPlans(this.supabase, userId, { startDate, endDate });
    const scheduledMinutes = plans.reduce(
      (sum, plan) => sum + minutesBetween(plan.start_at, plan.end_at),
      0,
    );
    return computeBlankRate(scheduledMinutes, { startDate, endDate, wakeHour, sleepHour });
  }

  /** 見積もり精度の共通計算。 */
  async computeEstimationAccuracy(
    userId: string,
    plans: ReadonlyArray<StatPlanRow>,
    activitiesById: ReadonlyMap<string, ActivityLookupRow>,
    categoriesById: ReadonlyMap<string, CategoryLookupRow>,
    range: DateRangeInput = {},
  ): Promise<EstimationAccuracyDbRow[]> {
    const records = await fetchRecords(this.supabase, userId, range);
    // アクティビティ自身は色を持たないため、所属カテゴリーの色をここで継承させておく
    const activityLookup: Map<string, EstimationAccuracyActivityLookup> = new Map(
      Array.from(activitiesById.entries()).map(([id, activity]) => {
        const category =
          activity.category_id == null ? undefined : categoriesById.get(activity.category_id);
        return [id, { name: activity.name, color: category?.color ?? null }];
      }),
    );

    return aggregatePlanRecordEstimationAccuracy(
      [
        ...plans.map((row) => toDerivedBlock(row, 'plan')),
        ...records.map((row) => toDerivedBlock(row, 'rec')),
      ],
      {
        startAt: range.startDate ?? '1970-01-01T00:00:00Z',
        endAt: range.endDate ?? new Date().toISOString(),
        timezone: 'UTC',
      },
      new Date(),
      activityLookup,
    );
  }
}
