/**
 * `plans` テーブル行 -> `PlanEvent` 変換アダプター（Step 5、read 側専用）
 *
 * `entry-adapter.ts`（entries -> CalendarDisplayEvent）と同じ配置パターンで、
 * plans -> PlanEvent の射影を担う。書き込み・DnD 保存先判定は Step 6。
 */

import type { PlanEvent, PlanEventStatus } from '@/features/timeblock';
import { convertToTimezone } from '@/lib/date/timezone';

/** `plans` テーブル行のうち PlanEvent 射影に必要な最小 shape */
export interface PlanEventSourceRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
}

/** TZ変換やDBから読み出した秒以下のずれが所要時間計算にノイズを混ぜないよう truncate する */
function truncateToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

/**
 * 「過去 Plan の見え方」に基づく status 判定（docs/product/specs/plan-record.md §記録操作と表示）。
 *
 * 優先順位: 同じ時間帯の記録あり > 時間位置（unrecorded/active/upcoming）
 */
function resolvePlanEventStatus({
  startDate,
  endDate,
  hasRecords,
  now,
}: {
  startDate: Date;
  endDate: Date;
  hasRecords: boolean;
  now: Date;
}): PlanEventStatus {
  if (hasRecords) return 'with-records';
  if (endDate.getTime() <= now.getTime()) return 'unrecorded';
  if (startDate.getTime() <= now.getTime()) return 'active';
  return 'upcoming';
}

interface PlanRowToPlanEventOptions {
  timezone: string;
  /** 同じアクティビティで15分以上重なる Record が1件以上あるか。 */
  hasRecords: boolean;
  /** テスト用の時刻固定。省略時は `new Date()` */
  now?: Date;
}

export function planRowToPlanEvent(
  row: PlanEventSourceRow,
  options: PlanRowToPlanEventOptions,
): PlanEvent {
  const startDate = truncateToMinute(new Date(row.start_at));
  const endDate = truncateToMinute(new Date(row.end_at));
  const now = options.now ?? new Date();
  const duration = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  return {
    id: row.id,
    title: row.title || '',
    note: row.note,
    activityId: row.activity_id,
    startDate,
    endDate,
    displayStartDate: convertToTimezone(startDate, options.timezone),
    displayEndDate: convertToTimezone(endDate, options.timezone),
    duration,
    status: resolvePlanEventStatus({
      startDate,
      endDate,
      hasRecords: options.hasRecords,
      now,
    }),
  };
}

interface ExpandPlanRowsOptions {
  timezone: string;
  /** 同じ時間帯の Record がある Plan ID の導出集合。 */
  planIdsWithRecords: ReadonlySet<string>;
  now?: Date;
}

export function expandPlanRowsToPlanEvents(
  rows: ReadonlyArray<PlanEventSourceRow>,
  options: ExpandPlanRowsOptions,
): PlanEvent[] {
  return rows.map((row) =>
    planRowToPlanEvent(row, {
      timezone: options.timezone,
      hasRecords: options.planIdsWithRecords.has(row.id),
      ...(options.now !== undefined && { now: options.now }),
    }),
  );
}
