import { useCallback } from 'react';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { useCurrentPeriod, useDateUtilities, useTimeblocksByDate } from '../../shared';

/** useMultiDayView フックのオプション */
interface UseMultiDayViewOptions {
  centerDate: Date;
  dayCount: number;
  timezone: string;
  events?: CalendarDisplayEvent[];
  showWeekends?: boolean;
}

/** useMultiDayView フックの戻り値 */
interface UseMultiDayViewReturn {
  displayDates: Date[];
  eventsByDate: Record<string, CalendarDisplayEvent[]>;
  centerIndex: number;
  todayIndex: number;
  isCurrentDay: boolean;
  scrollToNow: () => void;
}

/**
 * MultiDayView用の汎用フック
 *
 * @description
 * - centerDateを中心にdayCount日間を生成
 * - 2〜7日間に対応
 */
export function useMultiDayView({
  centerDate,
  dayCount,
  timezone,
  events = [],
  showWeekends = true,
}: UseMultiDayViewOptions): UseMultiDayViewReturn {
  const { dates: displayDates } = useDateUtilities({
    referenceDate: centerDate,
    viewType: 'multiday',
    dayCount,
    showWeekends,
  });

  const { isCurrentPeriod: isCurrentDay, todayIndex } = useCurrentPeriod({
    dates: displayDates,
    periodType: 'multiday',
  });

  const centerIndex = Math.floor(dayCount / 2);

  const { timeblocksByDate: eventsByDate } = useTimeblocksByDate({
    dates: displayDates,
    timeblocks: events,
    sortType: 'standard',
    timezone,
  });

  // スクロール処理はScrollableCalendarLayoutに委譲
  const scrollToNow = useCallback(() => {}, []);

  return {
    displayDates,
    eventsByDate,
    centerIndex,
    todayIndex,
    isCurrentDay,
    scrollToNow,
  };
}
