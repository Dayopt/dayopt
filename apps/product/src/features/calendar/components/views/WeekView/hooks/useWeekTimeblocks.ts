import { useMemo } from 'react';

import { layoutEntryToVerticalPosition } from '../../../../lib/grid';
import { calculateTimeblockLayouts, type TimeblockLayout } from '../../../../lib/layout';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import type {
  UseWeekEntriesOptions,
  UseWeekEntriesReturn,
  WeekEntryPosition,
} from '../../../../types/week-view.types';
import { getDateKey, isValidEvent, sortEventsByDateKeys } from '../../shared';
import { HOUR_HEIGHT } from '../../shared/constants/grid.constants';
import { getTimeblockStackIndex } from '../../shared/utils/timeblockStacking';

/**
 * 週ビューでのエントリ位置計算専用フック
 *
 * @description
 * - エントリの重なり検出（共有layoutエンジン使用）
 * - 位置とサイズの計算
 * - 最大同時エントリ数の算出
 */
export function useWeekTimeblocks({
  weekDates,
  events: entries = [],
  hourHeight = HOUR_HEIGHT,
  timezone,
}: UseWeekEntriesOptions): UseWeekEntriesReturn {
  // エントリを日付ごとにグループ化（raw startDate + ユーザーTZの日付キーで判定）
  const entriesByDate = useMemo(() => {
    const grouped: Record<string, CalendarDisplayEvent[]> = {};

    // 各日付のキーを初期化
    weekDates.forEach((date) => {
      const dateKey = getDateKey(date, timezone);
      if (!(dateKey in grouped)) {
        grouped[dateKey] = [];
      }
    });

    // エントリを適切な日付に配置
    entries.forEach((entry) => {
      if (!isValidEvent(entry)) return;

      if (!entry.startDate) return;
      if (!entry.displayStartDate) return;

      const timeblockStart =
        entry.startDate instanceof Date ? entry.startDate : new Date(entry.startDate);

      // 無効な日付は除外
      if (isNaN(timeblockStart.getTime())) return;

      const timeblockDateKey = getDateKey(timeblockStart, timezone);

      // 週の範囲内の日付を確認
      weekDates.forEach((date) => {
        const dateKey = getDateKey(date, timezone);
        if (timeblockDateKey === dateKey) {
          if (Object.prototype.hasOwnProperty.call(grouped, dateKey) && grouped[dateKey]) {
            grouped[dateKey].push(entry);
          }
        }
      });
    });

    // 各日のエントリを時刻順にソート
    return sortEventsByDateKeys(grouped);
  }, [weekDates, entries, timezone]);

  // エントリの位置情報を計算（共有layoutエンジン使用）
  const timeblockPositions = useMemo(() => {
    const positions: WeekEntryPosition[] = [];

    const dayColumnWidth = weekDates.length > 0 ? 100 / weekDates.length : 100;

    weekDates.forEach((date, dayIndex) => {
      const dateKey = getDateKey(date, timezone);
      const dayEntries =
        (Object.prototype.hasOwnProperty.call(entriesByDate, dateKey)
          ? entriesByDate[dateKey]
          : null) || [];

      // CalendarDisplayEventをTimedTimeblock形式に変換（calculateTimeblockLayouts用）
      const timedEntries = dayEntries
        .filter((entry) => !!entry.displayStartDate)
        .map((entry) => ({
          ...entry,
          start: entry.displayStartDate,
          end: entry.displayEndDate || new Date(entry.displayStartDate.getTime() + 60 * 60 * 1000),
        }));

      // 共有layoutエンジンでカラム配置を計算
      const layouts = calculateTimeblockLayouts(timedEntries);

      // TimeblockLayoutをWeekEntryPositionに変換
      layouts.forEach((layout: TimeblockLayout, index: number) => {
        const entry = layout.timeblock as CalendarDisplayEvent;
        const { top, height } = layoutEntryToVerticalPosition(
          new Date(layout.timeblock.start),
          new Date(layout.timeblock.end),
          hourHeight,
        );

        // 日列内でのleft/widthを計算（dayColumnWidth内でlayout.left/widthを適用）
        const columnWidth = dayColumnWidth / layout.totalColumns;
        const left = dayIndex * dayColumnWidth + layout.column * columnWidth;
        const width = columnWidth * 0.95; // 少し余白を作る

        positions.push({
          plan: entry,
          dayIndex,
          top,
          height,
          left,
          width,
          zIndex: getTimeblockStackIndex(entry, index, 20),
          column: layout.column,
          totalColumns: layout.totalColumns,
        });
      });
    });

    return positions;
  }, [weekDates, entriesByDate, hourHeight, timezone]);

  // 最大同時エントリ数を計算（layoutエンジンの結果から導出）
  const maxConcurrentEntries = useMemo(() => {
    if (timeblockPositions.length === 0) return 0;
    return Math.max(0, ...timeblockPositions.map((pos) => pos.totalColumns));
  }, [timeblockPositions]);

  return {
    entriesByDate,
    timeblockPositions,
    maxConcurrentEntries,
  };
}
