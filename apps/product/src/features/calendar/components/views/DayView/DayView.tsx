'use client';

import React, { useMemo } from 'react';

import { getWeek } from 'date-fns';

import { cn } from '@dayopt/components';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { CalendarViewAnimation } from '../../animations/ViewTransition';
import { CalendarDateHeader, DateDisplay, ScrollableCalendarLayout } from '../shared';
import { CalendarGridContent } from '../shared/components/CalendarGridContent';

import type { DayViewProps } from '../../../types/day-view.types';
import { useDayView } from './hooks/useDayView';

/** 1日表示のカレンダービューコンポーネント */
export const DayView = ({
  dateRange: _dateRange,
  timeblocks,
  allTimeblocks,
  externalEvents,
  currentDate,
  showWeekends: _showWeekends = true,
  showActualDiff: _showActualDiff = false,
  dayDiffTimeblockIds,
  className,
  disabledTimeblockId,
  onTimeblockClick,
  onTimeblockContextMenu,
  onTimeblockUpdate,
  onDeleteTimeblock: _onDeleteTimeblock,
  onTimeRangeSelect,
  onViewChange: _onViewChange,
  onNavigatePrev: _onNavigatePrev,
  onNavigateNext: _onNavigateNext,
  onNavigateToday: _onNavigateToday,
}: DayViewProps) => {
  const timezone = useUserPreferences((s) => s.timezone);
  const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);

  // 表示する日付
  const displayDates = useMemo(() => {
    const date = new Date(currentDate);
    date.setHours(0, 0, 0, 0);
    return [date];
  }, [currentDate]);

  // 最初の日付を使用（Day表示なので1日のみ）
  const date = displayDates[0];
  if (!date) {
    throw new Error('Display date is undefined');
  }

  // ドラッグイベント用のハンドラー（タイムブロック時間更新）
  const handleEventTimeUpdate = React.useCallback(
    async (
      eventId: string,
      updates: {
        startTime: Date;
        endTime: Date;
        resetActualTime?: boolean;
      },
    ) => {
      if (onTimeblockUpdate) {
        // 返り値を伝播（繰り返しタイムブロック編集時の skipToast フラグ用）
        return await onTimeblockUpdate(eventId, updates);
      }
    },
    [onTimeblockUpdate],
  );

  // DayView専用ロジック（CalendarControllerから渡されたタイムブロックデータを使用）
  const {
    dayTimeblocks: dayEvents,
    timeblockStyles: _eventStyles,
    isToday,
    timeSlots: _timeSlots,
  } = useDayView({
    date,
    timeblocks: timeblocks || [],
    ...(onTimeblockUpdate && { onTimeblockUpdate: onTimeblockUpdate }),
    timezone,
  });

  // 週番号を計算
  const weekNumber = useMemo(() => {
    return getWeek(date, { weekStartsOn });
  }, [date, weekStartsOn]);

  const headerComponent = (
    <div className="flex h-8 items-center justify-between gap-2 px-2">
      <div className="flex-1" />
      <DateDisplay
        date={date}
        className="text-center"
        showDayName={true}
        showMonthYear={false}
        dayNameFormat="short"
        dateFormat="d"
        isToday={isToday}
        isSelected={false}
      />
      <div className="flex-1" />
    </div>
  );

  return (
    <CalendarViewAnimation viewType="day">
      <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
        {/* 固定日付ヘッダー */}
        <CalendarDateHeader
          header={headerComponent}
          weekNumber={weekNumber}
          className="hidden md:flex"
        />

        {/* スクロール可能コンテンツ */}
        <ScrollableCalendarLayout displayDates={displayDates} viewMode="day">
          {/* 日のコンテンツ */}
          <CalendarGridContent
            date={date}
            timeblocks={dayEvents}
            externalEvents={externalEvents}
            viewMode="day"
            dayIndex={0}
            allEventsForOverlapCheck={allTimeblocks ?? timeblocks}
            onTimeblockClick={onTimeblockClick}
            onTimeblockContextMenu={onTimeblockContextMenu}
            onEventUpdate={handleEventTimeUpdate}
            onTimeRangeSelect={onTimeRangeSelect}
            disabledTimeblockId={disabledTimeblockId}
            dayDiffTimeblockIds={dayDiffTimeblockIds}
            className="absolute inset-y-0 right-0 left-0"
          />
        </ScrollableCalendarLayout>
      </div>
    </CalendarViewAnimation>
  );
};
