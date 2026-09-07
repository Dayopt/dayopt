import { aggregate, type DerivedBlock, type DerivedPeriod } from './derived-model';

/**
 * 見積もり精度（estimation accuracy）の pure transformation。
 *
 * Server 層 (`features/timeblock/server/statistics.ts`) の `getEstimationAccuracy`
 * から DB 行 → tRPC response shape の snake→camel 変換だけを切り出している。
 *
 * Review UI が消費する型 (`features/review/types/metrics.types.ts` の
 * `EstimationAccuracyData`) と構造的に互換だが、boundary rule により
 * review/domain への配置は不可。
 *
 * 集計キーは tag_id から activity_id へ移行済み（tag-model-replacement Step 5
 * §3-C）。集計の意味論（未分類の畳み方・除外条件・n>=2 閾値）は tag 版から変更していない。
 */

export interface EstimationAccuracyDbRow {
  activity_id: string | null;
  activity_name: string | null;
  activity_color: string | null;
  /** アクティビティ削除等で `activity_id` が未分類バケットに畳まれた行かどうか */
  is_uncategorized: boolean;
  avg_planned_minutes: number;
  avg_actual_minutes: number;
  avg_deviation_minutes: number;
  record_count: number;
}

interface EstimationAccuracyItem {
  activityId: string | null;
  activityName: string | null;
  /** 未分類なら null。空文字の場合は 'indigo' にフォールバック */
  activityColor: string | null;
  isUncategorized: boolean;
  avgPlannedMinutes: number;
  avgActualMinutes: number;
  avgDeviationMinutes: number;
  recordCount: number;
}

/**
 * DB RPC 行配列を tRPC response 用に変換する。
 *
 * - snake_case → camelCase
 * - `activity_color` が空文字なら `'indigo'` にフォールバック（未分類行は null のまま）
 */
export function transformEstimationAccuracy(
  rows: ReadonlyArray<EstimationAccuracyDbRow>,
): EstimationAccuracyItem[] {
  return rows.map((row) => ({
    activityId: row.activity_id,
    activityName: row.activity_name,
    activityColor: row.is_uncategorized ? null : row.activity_color || 'indigo',
    isUncategorized: row.is_uncategorized,
    avgPlannedMinutes: row.avg_planned_minutes,
    avgActualMinutes: row.avg_actual_minutes,
    avgDeviationMinutes: row.avg_deviation_minutes,
    recordCount: row.record_count,
  }));
}

export interface EstimationAccuracyActivityLookup {
  name: string;
  color: string | null;
}

/** Period averages use independent records and elapsed plans, never paired samples. */
export function aggregatePlanRecordEstimationAccuracy(
  blocks: readonly DerivedBlock[],
  period: DerivedPeriod,
  now: Date,
  activitiesById: ReadonlyMap<string, EstimationAccuracyActivityLookup>,
): EstimationAccuracyDbRow[] {
  const normalized = blocks.map((block) => ({
    ...block,
    activityId:
      block.activityId !== null && activitiesById.has(block.activityId) ? block.activityId : null,
  }));
  const rows: EstimationAccuracyDbRow[] = [];
  for (const activityId of new Set(normalized.map((block) => block.activityId))) {
    const totals = aggregate(period, activityId, normalized, now);
    if (totals.plannedPastBoxes < 2 || totals.plannedPastMinutes < 15 || totals.recordBoxes === 0)
      continue;
    const activity = activityId === null ? undefined : activitiesById.get(activityId);
    rows.push({
      activity_id: activityId,
      activity_name: activity?.name ?? null,
      activity_color: activity?.color ?? null,
      is_uncategorized: activity === undefined,
      avg_planned_minutes: totals.plannedPastMinutes / totals.plannedPastBoxes,
      avg_actual_minutes: totals.recordedMinutes / totals.plannedPastBoxes,
      avg_deviation_minutes:
        (totals.recordedMinutes - totals.plannedPastMinutes) / totals.plannedPastBoxes,
      record_count: totals.recordBoxes,
    });
  }
  return rows.sort((a, b) => b.record_count - a.record_count);
}
