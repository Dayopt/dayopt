import type { CalendarDisplayEvent } from '../types/calendar.types';

interface PlanRecordDropRange {
  start: Date;
  end: Date;
}

interface PlanRecordDropInput {
  title: string;
  note: string | null;
  activityId: string | null;
  start_at: string;
  end_at: string;
}

/**
 * Record レーンへ drop した Plan と preview range から、独立した manual Record を作る入力を組み立てる。
 * Plan 自身の予定時間は変更せず、drop 先の範囲を実績時間の source of truth とする。
 */
export function buildPlanRecordDropInput(
  plan: CalendarDisplayEvent,
  range: PlanRecordDropRange,
): PlanRecordDropInput {
  return {
    title: plan.title,
    note: plan.description ?? null,
    activityId: plan.activityId ?? null,
    start_at: range.start.toISOString(),
    end_at: range.end.toISOString(),
  };
}
