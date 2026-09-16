'use client';

import React from 'react';

import { getWeek } from 'date-fns';

import { useCalendarDisplayModeStore } from '@/features/calendar/stores/useCalendarDisplayModeStore';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { isTodayInTimezone } from '@/lib/date/timezone';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { cn } from '@dayopt/components';

import {
  CalendarDateHeader,
  DateDisplay,
  ScrollableCalendarLayout,
  getDateKey,
} from '../../shared';
import { CalendarGridContent } from '../../shared/components/CalendarGridContent';
import { useResponsiveHourHeight } from '../../shared/hooks/useResponsiveHourHeight';
import { useWeekTimeblocks } from '../hooks/useWeekTimeblocks';
import { MobileWeekLaneSwitcher } from './MobileWeekLaneSwitcher';

import type { WeekGridProps } from '../../../../types/week-view.types';

/**
 * WeekGrid - 週表示のメイングリッドコンポーネント
 *
 * @description
 * 7日分のグリッド管理:
 * - 各列の幅を均等分割（100% / 7）
 * - 列間のボーダー
 * - スクロール同期
 * - 現在時刻線の表示
 */
export const WeekGrid = ({
  weekDates,
  events,
  allTimeblocks,
  externalEvents,
  eventsByDate: _eventsByDate,
  todayIndex: _todayIndex,
  disabledTimeblockId,
  onEventClick,
  onEventContextMenu,
  onEventUpdate,
  onTimeRangeSelect,
  className,
  showActualDiff: _showActualDiff = false,
  dayDiffTimeblockIds,
}: WeekGridProps) => {
  const timezone = useUserPreferences((s) => s.timezone);
  const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const mobileWeekDisplayMode = useCalendarDisplayModeStore((s) => s.mobileWeekDisplayMode);
  const setMobileWeekDisplayMode = useCalendarDisplayModeStore((s) => s.setMobileWeekDisplayMode);
  const laneDisplayMode: 'both' | 'plan' | 'record' = isMobile
    ? mobileWeekDisplayMode === 'planned'
      ? 'plan'
      : 'record'
    : 'both';

  // レスポンシブな時間高さ
  const hourHeight = useResponsiveHourHeight();

  // onEventUpdate を CalendarGridContent が期待する (eventId, { startTime, endTime }) 型に変換
  const handleEventUpdate = React.useCallback(
    async (
      eventId: string,
      updates: {
        startTime: Date;
        endTime: Date;
        resetActualTime?: boolean;
      },
    ) => {
      if (!onEventUpdate) return;
      return onEventUpdate(eventId, updates);
    },
    [onEventUpdate],
  );

  // タイムブロック位置計算（TZ変換済みの日付グルーピングも取得）
  const { timeblocksByDate: tzTimeblocksByDate } = useWeekTimeblocks({
    weekDates,
    events,
    hourHeight,
    timezone,
  });

  // 週番号を計算（週の最初の日から）
  const weekNumber = React.useMemo(() => {
    const firstDate = weekDates[0];
    if (!firstDate) return undefined;
    return getWeek(firstDate, { weekStartsOn });
  }, [weekDates, weekStartsOn]);

  const headerComponent = (
    <div className="flex h-8 flex-1">
      {/* 7日分の日付ヘッダー */}
      {weekDates.map((date) => (
        <div
          key={date.toISOString()}
          className="flex items-center justify-center px-1"
          style={{ width: `${100 / weekDates.length}%` }}
        >
          <DateDisplay
            date={date}
            className="text-center"
            showDayName={true}
            showMonthYear={false}
            dayNameFormat="short"
            dateFormat="d"
            isToday={isTodayInTimezone(date, timezone)}
            isSelected={false}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {isMobile ? (
        <MobileWeekLaneSwitcher
          value={mobileWeekDisplayMode}
          onValueChange={setMobileWeekDisplayMode}
          className="mx-2 my-1 shrink-0"
        />
      ) : null}

      {/* 固定日付ヘッダー */}
      <CalendarDateHeader header={headerComponent} weekNumber={weekNumber} />

      {/* スクロール可能コンテンツ */}
      <ScrollableCalendarLayout
        displayDates={weekDates}
        viewMode="week"
        enableKeyboardNavigation={true}
      >
        {/* 7日分のグリッド */}
        {weekDates.map((date, dayIndex) => {
          const dateKey = getDateKey(date, timezone);
          // TZ変換済みのtimeblocksByDateを使用（eventsByDateはTZ未対応）
          const dayEvents = tzTimeblocksByDate[dateKey] || [];

          return (
            <div
              key={date.toISOString()}
              className="relative flex-1 overflow-visible"
              style={{ width: `${100 / weekDates.length}%` }}
            >
              <CalendarGridContent
                date={date}
                timeblocks={dayEvents}
                externalEvents={externalEvents}
                viewMode="week"
                dayIndex={dayIndex}
                allEventsForOverlapCheck={allTimeblocks ?? events}
                displayDates={weekDates}
                onTimeblockClick={onEventClick}
                onTimeblockContextMenu={onEventContextMenu}
                onEventUpdate={handleEventUpdate}
                onTimeRangeSelect={onTimeRangeSelect}
                disabledTimeblockId={disabledTimeblockId}
                dayDiffTimeblockIds={dayDiffTimeblockIds}
                laneDisplayMode={laneDisplayMode}
                className="h-full"
              />
            </div>
          );
        })}
      </ScrollableCalendarLayout>
    </div>
  );
};
