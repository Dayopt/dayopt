import type { CSSProperties } from 'react';

import type { GridViewProps } from './base.types';
import type { CalendarDisplayEvent } from './calendar.types';
import type { TimeSlot } from './grid.types';

/** DayViewの固有Props（GridViewPropsを継承して時間グリッド機能を使用） */
export type DayViewProps = GridViewProps;

/** useDayView フックのオプション */
export interface UseDayViewOptions {
  date: Date;
  timeblocks: CalendarDisplayEvent[];
  onTimeblockUpdate?: (timeblock: CalendarDisplayEvent) => void;
  timezone: string;
}

/** useDayView フックの戻り値 */
export interface UseDayViewReturn {
  dayTimeblocks: CalendarDisplayEvent[];
  timeblockStyles: Record<string, CSSProperties>;
  isToday: boolean;
  timeSlots: TimeSlot[];
}

/** useDayTimeblocks フックのオプション */
export interface UseDayTimeblocksOptions {
  date: Date;
  timeblocks: CalendarDisplayEvent[];
  timezone: string;
}

/** useDayTimeblocks フックの戻り値 */
export interface UseDayTimeblocksReturn {
  dayTimeblocks: CalendarDisplayEvent[];
  timeblockPositions: TimeblockPosition[];
  maxConcurrentTimeblocks: number;
}

/** タイムブロックの計算済み位置情報 */
export interface TimeblockPosition {
  plan: CalendarDisplayEvent;
  top: number;
  height: number;
  left: number;
  width: number;
  zIndex: number;
  column: number;
  totalColumns: number;
}
