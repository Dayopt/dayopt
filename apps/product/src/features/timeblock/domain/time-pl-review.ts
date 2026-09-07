import { computePlanAccuracy, computePlanVariance, type PlanAccuracyStatus } from '@/lib/time';

import { aggregate, type DerivedBlock, type DerivedPeriod } from './derived-model';

export interface TimePLReviewSourceRow {
  /** アクティビティ未設定、およびアクティビティ削除で `activity_id = NULL` になった行は null */
  activityId: string | null;
  startAt: string;
  endAt: string;
}

export interface TimePLReviewActivity {
  /** 「アクティビティなし」バケットは null。`isNoActivity` と常に一致する */
  activityId: string | null;
  isNoActivity: boolean;
  plannedMinutes: number;
  recordedMinutes: number;
  varianceMinutes: number;
  variancePercent: number | null;
}

export type TimePLReviewSignal =
  | {
      code: 'plan_accuracy';
      rate: number;
      status: PlanAccuracyStatus;
    }
  | {
      code: 'largest_activity_variance';
      activityId: string | null;
      isNoActivity: boolean;
      direction: 'recorded_less_than_planned' | 'recorded_more_than_planned';
      absoluteMinutes: number;
    };

export interface TimePLReview {
  hasData: boolean;
  summary: {
    plannedMinutes: number;
    recordedMinutes: number;
    varianceMinutes: number;
  };
  accuracy: {
    rate: number;
    status: PlanAccuracyStatus;
  } | null;
  activities: TimePLReviewActivity[];
  signals: TimePLReviewSignal[];
}

/**
 * 最小Plan / Record行から、アクティビティ別の決定論的なTime P/L reviewを導出する。
 *
 * `activityId` が null の行は単一の「アクティビティなし」バケット（`activityId: null` /
 * `isNoActivity: true`）として集計に含める（#1576 の未分類バケットを #2162 で改称）。
 */
export function deriveTimePLReview(
  plans: ReadonlyArray<TimePLReviewSourceRow>,
  records: ReadonlyArray<TimePLReviewSourceRow>,
  period?: DerivedPeriod,
  now?: Date,
): TimePLReview {
  const blocks: DerivedBlock[] = [
    ...plans.map((row, index) => ({ ...toReadBlock(row, index), kind: 'plan' as const })),
    ...records.map((row, index) => ({ ...toReadBlock(row, index), kind: 'rec' as const })),
  ];
  const starts = blocks.map((row) => Date.parse(row.start));
  const ends = blocks.map((row) => Date.parse(row.end));
  const bounds = period ?? {
    startAt: new Date(starts.length > 0 ? Math.min(...starts) : 0).toISOString(),
    endAt: new Date(ends.length > 0 ? Math.max(...ends) : 0).toISOString(),
    timezone: 'UTC',
  };
  const activities = [...new Set(blocks.map((block) => block.activityId))]
    .map((activityId) => {
      const totals = aggregate(bounds, activityId, blocks, now ?? new Date(bounds.endAt));
      return {
        activityId,
        plannedMinutes: roundToTenth(totals.plannedPastMinutes),
        recordedMinutes: roundToTenth(totals.recordedMinutes),
        hasPlan: totals.plannedPastMinutes > 0,
      };
    })
    .filter((totals) => totals.hasPlan || totals.recordedMinutes > 0)
    .map((totals) => {
      const variance = computePlanVariance(
        totals.plannedMinutes,
        totals.recordedMinutes,
        totals.hasPlan,
      );
      return {
        activityId: totals.activityId,
        isNoActivity: totals.activityId == null,
        plannedMinutes: totals.plannedMinutes,
        recordedMinutes: totals.recordedMinutes,
        varianceMinutes: roundToTenth(variance.varianceMinutes),
        variancePercent: variance.variancePercent,
      };
    })
    .sort(
      (left, right) =>
        Math.max(right.plannedMinutes, right.recordedMinutes) -
          Math.max(left.plannedMinutes, left.recordedMinutes) ||
        compareIds(left.activityId, right.activityId),
    );

  const plannedMinutes = roundToTenth(
    activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  );
  const recordedMinutes = roundToTenth(
    activities.reduce((sum, activity) => sum + activity.recordedMinutes, 0),
  );
  const summary = {
    plannedMinutes,
    recordedMinutes,
    varianceMinutes: roundToTenth(plannedMinutes - recordedMinutes),
  };

  if (activities.length === 0) {
    return {
      hasData: false,
      summary,
      accuracy: null,
      activities: [],
      signals: [],
    };
  }

  const derivedAccuracy = computePlanAccuracy(summary.plannedMinutes, summary.recordedMinutes);
  const accuracy = {
    rate: roundToFourDecimals(derivedAccuracy.rate),
    status: derivedAccuracy.status,
  };
  const signals: TimePLReviewSignal[] = [
    {
      code: 'plan_accuracy',
      rate: accuracy.rate,
      status: accuracy.status,
    },
  ];

  const largestVariance = [...activities].sort(
    (left, right) =>
      Math.abs(right.varianceMinutes) - Math.abs(left.varianceMinutes) ||
      compareIds(left.activityId, right.activityId),
  )[0];
  if (largestVariance && largestVariance.varianceMinutes !== 0) {
    signals.push({
      code: 'largest_activity_variance',
      activityId: largestVariance.activityId,
      isNoActivity: largestVariance.isNoActivity,
      direction:
        largestVariance.varianceMinutes > 0
          ? 'recorded_less_than_planned'
          : 'recorded_more_than_planned',
      absoluteMinutes: Math.abs(largestVariance.varianceMinutes),
    });
  }

  return {
    hasData: true,
    summary,
    accuracy,
    activities,
    signals,
  };
}

function toReadBlock(row: TimePLReviewSourceRow, index: number) {
  return {
    id: String(index),
    activityId: row.activityId,
    start: row.startAt,
    end: row.endAt,
    memo: null,
    fulfillment: null,
    live: false,
    source: 'manual',
  };
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundToFourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** tie-break専用の全順序。アクティビティなし（null）は同点時だけ末尾へ回す。 */
function compareIds(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left < right ? -1 : 1;
}
