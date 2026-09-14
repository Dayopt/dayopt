/**
 * カレンダー表示範囲の query input builder — React/DOM 依存ゼロの純粋関数
 *
 * server prefetch（`_server/calendar-prefetch.ts`）と client query（`useCalendarData`）が
 * `plans.list` / `records.list` / `externalCalendar.listEvents` に渡す input の**唯一の定義**。
 * tRPC + TanStack Query の query key は input を含むため、両者が 1 文字でも違う input を
 * 組むと server で先読みした cache が client に引き継がれず、初回表示で同じ範囲を取り直す
 * （#2747。旧 server 実装は暦日を `T00:00:00.000Z` の偽 UTC で組み、weekStartsOn を 1 に固定し、
 * limit: 100 を足していたため 3 点とも不一致だった）。
 */

import { toTZEndISO, toTZStartISO } from '@/lib/date/timezone';

import type { CalendarViewType } from '../types/calendar.types';
import { calculateViewDateRange } from './view-range';

/** user_settings の row が無い時の週開始日（client の `toUserPreferences(undefined)` と同値） */
export const DEFAULT_WEEK_STARTS_ON = 1 as const;

/** user_settings の row が無い時の週末表示（client の `toCalendarSettings(undefined)` と同値） */
export const DEFAULT_SHOW_WEEKENDS = true;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface CalendarRangeInputOptions {
  viewType: CalendarViewType;
  /**
   * 表示の基準日（`yyyy-MM-dd`）。Date ではなく日付キーで受ける。
   *
   * Date で受けると「その Date をどの TZ で暦日に読むか」を呼び出し側ごとに決めることになり、
   * server 側で URL 由来の Date に TZ 変換を二重に掛けて 1 日ずれる class が残る。
   * client は `getDateKey(currentDate)`（壁時計読み取り）、server は `?date=` の値そのものか
   * 「今日」の TZ 暦日を渡す。
   */
  anchorDateKey: string;
  /** 日境界を UTC instant に変換する IANA timezone（user_settings.timezone を正とする） */
  timezone: string;
  weekStartsOn: 0 | 1 | 6;
  showWeekends: boolean;
}

interface CalendarRangeInput {
  startDate: string;
  endDate: string;
}

interface TimeblockListInput extends CalendarRangeInput {
  sortBy: 'start_at';
  sortOrder: 'asc';
}

/** 日付キーを、そのローカル暦日の正午を指す壁時計 Date にする（`parseCalendarDateParam` と同じ基準）。 */
function toWallClockDate(dateKey: string): Date {
  if (!DATE_KEY_PATTERN.test(dateKey)) {
    throw new RangeError(`anchorDateKey must be yyyy-MM-dd: ${dateKey}`);
  }
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** 表示範囲の `[startDate, endDate]` を user timezone の日境界で UTC ISO にする。 */
export function buildCalendarRangeInput({
  viewType,
  anchorDateKey,
  timezone,
  weekStartsOn,
  showWeekends,
}: CalendarRangeInputOptions): CalendarRangeInput {
  const range = calculateViewDateRange(
    viewType,
    toWallClockDate(anchorDateKey),
    weekStartsOn,
    showWeekends,
  );
  return {
    startDate: toTZStartISO(range.start, timezone),
    endDate: toTZEndISO(range.end, timezone),
  };
}

/**
 * `plans.list` / `records.list` の input。
 *
 * limit は付けない（付けると key が変わる上、100 件で表示が黙って欠ける）。
 * pagination policy を入れる時はここを変え、server / client が同時に追従する。
 */
export function buildTimeblockListInput(options: CalendarRangeInputOptions): TimeblockListInput {
  return {
    ...buildCalendarRangeInput(options),
    sortBy: 'start_at',
    sortOrder: 'asc',
  };
}
