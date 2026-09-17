import { useMemo } from 'react';

import { layoutTimeblockToVerticalPosition } from '../../../../lib/grid';
import { calculateTimeblockLayouts, type TimeblockLayout } from '../../../../lib/layout';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import type {
  UseWeekTimeblocksOptions,
  UseWeekTimeblocksReturn,
  WeekTimeblockPosition,
} from '../../../../types/week-view.types';
import { getDateKey, isValidEvent, sortEventsByDateKeys } from '../../shared';
import { HOUR_HEIGHT } from '../../shared/constants/grid.constants';
import { getTimeblockStackIndex } from '../../shared/utils/timeblockStacking';

/**
 * 週ビューでのタイムブロック位置計算専用フック
 *
 * @description
 * - タイムブロックの重なり検出（共有layoutエンジン使用）
 * - 位置とサイズの計算
 * - 最大同時タイムブロック数の算出
 */
export function useWeekTimeblocks({
  weekDates,
  events: timeblocks = [],
  hourHeight = HOUR_HEIGHT,
  timezone,
}: UseWeekTimeblocksOptions): UseWeekTimeblocksReturn {
  // タイムブロックを日付ごとにグループ化（raw startDate + ユーザーTZの日付キーで判定）
  const timeblocksByDate = useMemo(() => {
    const grouped: Record<string, CalendarDisplayEvent[]> = {};

    // 各日付のキーを初期化
    weekDates.forEach((date) => {
      const dateKey = getDateKey(date, timezone);
      if (!(dateKey in grouped)) {
        grouped[dateKey] = [];
      }
    });

    // タイムブロックを適切な日付に配置
    timeblocks.forEach((timeblock) => {
      if (!isValidEvent(timeblock)) return;

      if (!timeblock.startDate) return;
      if (!timeblock.displayStartDate) return;

      const timeblockStart =
        timeblock.startDate instanceof Date ? timeblock.startDate : new Date(timeblock.startDate);

      // 無効な日付は除外
      if (isNaN(timeblockStart.getTime())) return;

      const timeblockDateKey = getDateKey(timeblockStart, timezone);

      // 週の範囲内の日付を確認
      weekDates.forEach((date) => {
        const dateKey = getDateKey(date, timezone);
        if (timeblockDateKey === dateKey) {
          if (Object.prototype.hasOwnProperty.call(grouped, dateKey) && grouped[dateKey]) {
            grouped[dateKey].push(timeblock);
          }
        }
      });
    });

    // 各日のタイムブロックを時刻順にソート
    return sortEventsByDateKeys(grouped);
  }, [weekDates, timeblocks, timezone]);

  // タイムブロックの位置情報を計算（共有layoutエンジン使用）
  const timeblockPositions = useMemo(() => {
    const positions: WeekTimeblockPosition[] = [];

    const dayColumnWidth = weekDates.length > 0 ? 100 / weekDates.length : 100;

    weekDates.forEach((date, dayIndex) => {
      const dateKey = getDateKey(date, timezone);
      const dayTimeblocks =
        (Object.prototype.hasOwnProperty.call(timeblocksByDate, dateKey)
          ? timeblocksByDate[dateKey]
          : null) || [];

      // CalendarDisplayEventをTimedTimeblock形式に変換（calculateTimeblockLayouts用）
      const timedTimeblocks = dayTimeblocks
        .filter((timeblock) => !!timeblock.displayStartDate)
        .map((timeblock) => ({
          ...timeblock,
          start: timeblock.displayStartDate,
          end:
            timeblock.displayEndDate ||
            new Date(timeblock.displayStartDate.getTime() + 60 * 60 * 1000),
        }));

      // 共有layoutエンジンでカラム配置を計算
      const layouts = calculateTimeblockLayouts(timedTimeblocks);

      // TimeblockLayoutをWeekTimeblockPositionに変換
      layouts.forEach((layout: TimeblockLayout, index: number) => {
        const timeblock = layout.timeblock as CalendarDisplayEvent;
        const { top, height } = layoutTimeblockToVerticalPosition(
          new Date(layout.timeblock.start),
          new Date(layout.timeblock.end),
          hourHeight,
        );

        // 日列内でのleft/widthを計算（dayColumnWidth内でlayout.left/widthを適用）
        const columnWidth = dayColumnWidth / layout.totalColumns;
        const left = dayIndex * dayColumnWidth + layout.column * columnWidth;
        const width = columnWidth * 0.95; // 少し余白を作る

        positions.push({
          plan: timeblock,
          dayIndex,
          top,
          height,
          left,
          width,
          zIndex: getTimeblockStackIndex(timeblock, index, 20),
          column: layout.column,
          totalColumns: layout.totalColumns,
        });
      });
    });

    return positions;
  }, [weekDates, timeblocksByDate, hourHeight, timezone]);

  // 最大同時タイムブロック数を計算（layoutエンジンの結果から導出）
  const maxConcurrentTimeblocks = useMemo(() => {
    if (timeblockPositions.length === 0) return 0;
    return Math.max(0, ...timeblockPositions.map((pos) => pos.totalColumns));
  }, [timeblockPositions]);

  return {
    timeblocksByDate,
    timeblockPositions,
    maxConcurrentTimeblocks,
  };
}
