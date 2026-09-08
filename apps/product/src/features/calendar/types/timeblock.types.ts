/**
 * エントリ関連の型定義
 */

import type { CalendarDisplayEvent } from './calendar.types';

/** 時間指定エントリ型（startDate/endDateをstart/endにエイリアス） */
export type TimedTimeblock = CalendarDisplayEvent & {
  start: Date; // startDateのエイリアス
  end: Date; // endDateのエイリアス
};

/** カラム割り当て済みのエントリ列情報 */
export interface TimeblockColumn {
  entries: CalendarDisplayEvent[];
  columnIndex: number;
  totalColumns: number;
}
