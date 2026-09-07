/**
 * Record の物理テーブル `records` の行 -> `RecordEvent` 変換アダプター（read 側専用）
 *
 * `entry-adapter.ts`（entries -> CalendarDisplayEvent）と同じ配置パターンで、
 * 物理 `records` -> RecordEvent の境界射影を担う。
 */

import type { RecordEvent } from '@/features/timeblock';
import { convertToTimezone } from '@/lib/date/timezone';

/** Record の物理テーブル `records` のうち RecordEvent 射影に必要な最小 shape */
export interface RecordEventSourceRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  source: string;
  start_at: string;
  end_at: string;
}

/** TZ変換やDBから読み出した秒以下のずれが所要時間計算にノイズを混ぜないよう truncate する */
function truncateToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

interface RecordRowToRecordEventOptions {
  timezone: string;
}

export function recordRowToRecordEvent(
  row: RecordEventSourceRow,
  options: RecordRowToRecordEventOptions,
): RecordEvent {
  const startDate = truncateToMinute(new Date(row.start_at));
  const endDate = truncateToMinute(new Date(row.end_at));
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
  };
}

/** Records are independently projected; no representative or paired difference exists. */
export function expandRecordRowsToRecordEvents(
  rows: ReadonlyArray<RecordEventSourceRow>,
  options: { timezone: string },
): RecordEvent[] {
  return rows.map((row) => recordRowToRecordEvent(row, options));
}
