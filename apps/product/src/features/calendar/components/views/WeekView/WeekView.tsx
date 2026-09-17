'use client';

import { isWeekend } from 'date-fns';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { CalendarViewAnimation } from '../../animations/ViewTransition';

import { WeekGrid } from './components/WeekGrid';
import { useWeekView } from './hooks/useWeekView';

import type { WeekViewProps } from '../../../types/week-view.types';

/**
 * WeekView - 週表示ビューコンポーネント
 *
 * @description
 * 構成:
 * 1. shared/DateDisplay で7日分の日付表示
 * 2. ScrollableCalendarLayout（時間軸 + グリッド + 現在時刻線）
 * 3. 7つの WeekContent を横並び
 * 4. TimeblockCard でタイムブロック表示
 *
 * レイアウト:
 * ┌────┬────┬────┬────┬────┬────┬────┬────┐
 * │    │ 17 │ 18 │ 19 │ 20 │ 21 │ 22 │ 23 │
 * │    │ 日 │ 月 │ 火 │ 水 │ 木 │ 金 │ 土 │ ← DateDisplay
 * │    │    │    │    │ ● │    │    │    │ ← 今日マーカー
 * ├────┼────┼────┼────┼────┼────┼────┼────┤
 * │ 9  │    │ PL │    │    │ PL │    │    │
 * │10  │    │    │ PL │    │    │    │    │
 * └────┴────┴────┴────┴────┴────┴────┴────┘
 */
export const WeekView = ({
  dateRange,
  timeblocks,
  allTimeblocks,
  externalEvents,
  showWeekends = true,
  weekStartsOn: weekStartsOnProp,
  showActualDiff = false,
  dayDiffTimeblockIds,
  className,
  disabledTimeblockId,
  onTimeblockClick,
  onTimeblockContextMenu,
  onTimeblockUpdate,
  onTimeRangeSelect,
}: WeekViewProps) => {
  const weekStartsOnSetting = useUserPreferences((s) => s.weekStartsOn);
  const timezone = useUserPreferences((s) => s.timezone);
  // 設定ストアの値を優先、プロップでオーバーライド可能
  const weekStartsOn = weekStartsOnProp ?? weekStartsOnSetting;

  // WeekView専用ロジック
  const { weekDates, eventsByDate, todayIndex } = useWeekView({
    startDate: dateRange.start,
    events: timeblocks,
    timezone,
    weekStartsOn,
  });

  // 表示する日付を計算（土日を除外するかどうか）
  const displayDates = showWeekends ? weekDates : weekDates.filter((day) => !isWeekend(day));

  // 初期スクロールはScrollableCalendarLayoutに委譲

  return (
    <CalendarViewAnimation viewType="week">
      <WeekGrid
        weekDates={displayDates}
        events={timeblocks}
        allTimeblocks={allTimeblocks}
        externalEvents={externalEvents}
        eventsByDate={eventsByDate}
        todayIndex={todayIndex}
        disabledTimeblockId={disabledTimeblockId}
        onEventClick={onTimeblockClick}
        onEventContextMenu={onTimeblockContextMenu}
        onEventUpdate={onTimeblockUpdate}
        onTimeRangeSelect={onTimeRangeSelect}
        className={className}
        showActualDiff={showActualDiff}
        dayDiffTimeblockIds={dayDiffTimeblockIds}
      />
    </CalendarViewAnimation>
  );
};
