// CalendarDisplayEvent は features/timeblock/types/calendar-event.ts の CalendarEvent が
// canonical source (Timeblock の表示射影型のため owner は timeblock)。calendar 側では別名で
// re-export し、timeblock canonical 名との衝突（誤 import の温床）を避ける（#2221）。
export type { CalendarEvent as CalendarDisplayEvent } from '@/features/timeblock';

// CalendarViewType 関連は feature 内の lib/constants が canonical source
export { getMultiDayCount, isMultiDayView } from '../lib/constants';
export type { CalendarViewType, MultiDayViewType } from '../lib/constants';

/** ビューの日付範囲（開始・終了・各日の配列） */
export interface ViewDateRange {
  start: Date;
  end: Date;
  days: Date[];
}
