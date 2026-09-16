'use client';

/**
 * CalendarTimeblockActionsContext
 *
 * タイムブロック操作ハンドラ（click, update, delete, timeRangeSelect）を提供する。
 * CalendarController で Provider を設置し、View以下のコンポーネントが
 * props drilling なしでアクセスできるようにする。
 */

import { createContext } from 'react';

import type { CalendarDisplayEvent } from '../types/calendar.types';

interface CalendarTimeblockActions {
  onTimeblockClick?: ((timeblock: CalendarDisplayEvent) => void) | undefined;
  onTimeblockContextMenu?:
    ((timeblock: CalendarDisplayEvent, e: React.MouseEvent) => void) | undefined;
  onTimeblockUpdate?:
    | ((
        timeblockIdOrTimeblock: string | CalendarDisplayEvent,
        updates?: {
          startTime: Date;
          endTime: Date;
          resetActualTime?: boolean;
        },
      ) => void | Promise<void> | Promise<{ skipToast: true } | void>)
    | undefined;
  onDeleteTimeblock?: ((timeblockId: string) => void) | undefined;
  onTimeRangeSelect?:
    | ((selection: {
        date: Date;
        startHour: number;
        startMinute: number;
        endHour: number;
        endMinute: number;
      }) => void)
    | undefined;
  disabledTimeblockId?: string | null | undefined;
}

const CalendarTimeblockActionsContext = createContext<CalendarTimeblockActions>({});

export function CalendarTimeblockActionsProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: CalendarTimeblockActions;
}) {
  return (
    <CalendarTimeblockActionsContext.Provider value={value}>
      {children}
    </CalendarTimeblockActionsContext.Provider>
  );
}
