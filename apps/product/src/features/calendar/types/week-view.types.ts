import type { ExternalCalendarEvent } from '@/features/external-calendar';

import type { BaseTimeblockPosition, GridViewProps } from './base.types';
import type { CalendarDisplayEvent } from './calendar.types';

import type { DateTimeSelection } from '../components/views/shared';

/** WeekView の固有Props（GridViewPropsを継承して時間グリッド機能を使用） */
export interface WeekViewProps extends GridViewProps {
  weekStartsOn?: 0 | 1 | 6; // 0: 日曜始まり, 1: 月曜始まり, 6: 土曜始まり
}

/** WeekGrid コンポーネントのプロパティ */
export interface WeekGridProps {
  weekDates: Date[];
  events: CalendarDisplayEvent[];
  /** 全タイムブロック（期限切れ未完了表示用） */
  allTimeblocks?: CalendarDisplayEvent[] | undefined;
  /** 外部カレンダーの未変換予定（ghost、読み取り専用） */
  externalEvents?: ExternalCalendarEvent[] | undefined;
  eventsByDate: Record<string, CalendarDisplayEvent[]>;
  todayIndex: number;
  /** DnDを無効化するTimeblock ID（Inspector表示中のTimeblock など） */
  disabledTimeblockId?: string | null | undefined;
  onEventClick?: ((timeblock: CalendarDisplayEvent) => void) | undefined;
  onEventContextMenu?:
    ((timeblock: CalendarDisplayEvent, mouseEvent: React.MouseEvent) => void) | undefined;
  onEventUpdate?:
    | ((
        timeblockIdOrTimeblock: string | CalendarDisplayEvent,
        updates?: {
          startTime: Date;
          endTime: Date;
          resetActualTime?: boolean;
        },
      ) => void | Promise<void> | Promise<{ skipToast: true } | void>)
    | undefined;
  onTimeRangeSelect?: ((selection: DateTimeSelection) => void) | undefined;
  /** compare の差分 marker を表示する */
  showActualDiff?: boolean | undefined;
  /** compare Rail に出ている timeblock の ID 一覧 */
  dayDiffTimeblockIds?: ReadonlySet<string> | undefined;
  className?: string | undefined;
}

/** useWeekView フックのオプション */
export interface UseWeekViewOptions {
  startDate: Date;
  events: CalendarDisplayEvent[];
  timezone: string;
  weekStartsOn?: 0 | 1 | 6;
  onEventUpdate?: (
    timeblockIdOrTimeblock: string | CalendarDisplayEvent,
    updates?: {
      startTime: Date;
      endTime: Date;
      resetActualTime?: boolean;
    },
  ) => void | Promise<void> | Promise<{ skipToast: true } | void>;
}

/** useWeekView フックの戻り値 */
export interface UseWeekViewReturn {
  weekDates: Date[];
  eventsByDate: Record<string, CalendarDisplayEvent[]>;
  todayIndex: number;
  scrollToNow: () => void;
  isCurrentWeek: boolean;
}

/** useWeekTimeblocks フックのオプション */
export interface UseWeekTimeblocksOptions {
  weekDates: Date[];
  events: CalendarDisplayEvent[];
  hourHeight?: number;
  timezone: string;
}

/** useWeekTimeblocks フックの戻り値 */
export interface UseWeekTimeblocksReturn {
  timeblocksByDate: Record<string, CalendarDisplayEvent[]>;
  timeblockPositions: WeekTimeblockPosition[];
  maxConcurrentTimeblocks: number;
}

/** 週ビューでのタイムブロック位置情報（BaseTimeblockPosition に dayIndex を追加） */
export interface WeekTimeblockPosition extends BaseTimeblockPosition {
  dayIndex: number;
}
