/**
 * タイムブロック関連の型定義
 */

import type { CalendarDisplayEvent } from './calendar.types';

/** 時間指定タイムブロック型（startDate/endDateをstart/endにエイリアス） */
export type TimedTimeblock = CalendarDisplayEvent & {
  start: Date; // startDateのエイリアス
  end: Date; // endDateのエイリアス
};

/** カラム割り当て済みのタイムブロック列情報 */
export interface TimeblockColumn {
  timeblocks: CalendarDisplayEvent[];
  columnIndex: number;
  totalColumns: number;
}
