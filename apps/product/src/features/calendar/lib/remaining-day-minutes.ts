/**
 * その日に「あと何時間置けるか」の計算。
 *
 * 定義は 1 本だけ: `残り = 24h − その暦日の予定合計 − 選択中の長さ`。
 * 今日 / 未来 / 過去で出し分けない。睡眠時間帯や外部カレンダーの予定は引かない
 * （睡眠を勘定に入れたい人は「睡眠」アクティビティの予定を置く。設定を増やさない）。
 *
 * `day-diff.ts` の `computeCalendarDayDiffs` を呼ばない理由: あちらは clip / diff item /
 * sort / Set 確保を伴い、日の切り方も `dayStart` / `dayEnd` 境界なので、ドラッグ中に毎フレーム
 * 呼ぶには重い。予定合計の意味（`kind !== 'record'` を予定と見る、`plannedStartDate ?? startDate`、
 * `isDraft` を除外、非正の長さは 0）だけをここへ写す。
 */

import type { CalendarDisplayEvent } from '../types/calendar.types';

import { formatDurationMinutes, getDateKey } from '@/lib/date';

/** 1 日の分数。タイムブロックは日を跨げないので、この値が分母になる。 */
export const DAY_MINUTES = 24 * 60;

/**
 * 予定の時間範囲。
 *
 * `CalendarDisplayEvent`（instant の Date）と `plans.list` cache 行（ISO 文字列）の
 * どちらからも作れるよう、構造だけを要求する。
 */
export interface RemainingDayPlanRange {
  start: Date | string;
  end: Date | string;
  isDraft?: boolean | undefined;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rangeMinutes(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60_000);
}

/**
 * 表示用の予定範囲へ射影する。
 *
 * activity filter の影響を受けないよう、呼び出し側は**未フィルタ**の一覧を渡す
 * （`CalendarGridContent` の `allEventsForOverlapCheck`、すなわち `allCalendarEvents`）。
 */
export function planRangesFromCalendarEvents(
  events: readonly CalendarDisplayEvent[],
): RemainingDayPlanRange[] {
  const ranges: RemainingDayPlanRange[] = [];

  for (const event of events) {
    if (event.kind === 'record') continue;

    const start = event.plannedStartDate ?? event.startDate;
    const end = event.plannedEndDate ?? event.endDate;
    if (!start || !end) continue;

    ranges.push({ start, end, isDraft: event.isDraft });
  }

  return ranges;
}

interface ComputeRemainingDayMinutesParams {
  /** 未フィルタの予定範囲。`start` / `end` は instant として解釈する */
  plans: readonly RemainingDayPlanRange[];
  /**
   * 選択日の暦日キー（`YYYY-MM-DD`）。
   *
   * 壁時計 Date から作る場合は `getDateKey(date)`（timezone を渡さない）を使う。
   * `pendingSelection.date` のような壁時計 Date に timezone を渡すと instant として
   * 再解釈され、system TZ とユーザー TZ が食い違う環境で日がずれる（#2017 と同型）。
   */
  dateKey: string;
  /** 予定側の instant をユーザーの暦日へ落とすための TZ */
  timezone: string;
  /** 選択中の長さ（分） */
  selectionMinutes: number;
}

/**
 * その日の残り時間（分）。24h を超えて置いている日は負になる。
 */
export function computeRemainingDayMinutes({
  plans,
  dateKey,
  timezone,
  selectionMinutes,
}: ComputeRemainingDayMinutesParams): number {
  let plannedMinutes = 0;

  for (const plan of plans) {
    if (plan.isDraft) continue;

    const start = toDate(plan.start);
    const end = toDate(plan.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (getDateKey(start, timezone) !== dateKey) continue;

    plannedMinutes += rangeMinutes(start, end);
  }

  return DAY_MINUTES - plannedMinutes - Math.max(selectionMinutes, 0);
}

/**
 * 残り時間の表示値。負の値は符号だけで示す（色や警告は付けない）。
 *
 * 記号は `TwoLane/DiffBadge` に合わせて ASCII の `-` を使う。
 */
export function formatRemainingDuration(minutes: number): string {
  const formatted = formatDurationMinutes(minutes);
  return minutes < 0 ? `-${formatted}` : formatted;
}
