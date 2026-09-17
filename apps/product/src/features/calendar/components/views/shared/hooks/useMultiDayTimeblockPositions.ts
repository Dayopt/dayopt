import { useMemo } from 'react';

import { isValid } from 'date-fns';

import { getDateKey } from '@/lib/date';
import { layoutTimeblockToVerticalPosition } from '../../../../lib/grid';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import { HOUR_HEIGHT as DEFAULT_HOUR_HEIGHT } from '../constants/grid.constants';
import { getTimeblockStackIndex } from '../utils/timeblockStacking';

import { useTimeblockLayoutCalculator, type TimeblockLayout } from './useTimeblockLayoutCalculator';
import type { TimeblockPosition } from './useViewTimeblocks';

/** useMultiDayTimeblockPositions フックのオプション */
interface UseMultiDayTimeblockPositionsOptions {
  displayDates: Date[];
  timeblocks: CalendarDisplayEvent[];
  hourHeight?: number;
  timezone: string;
}

/** useMultiDayTimeblockPositions フックの戻り値 */
interface UseMultiDayTimeblockPositionsReturn {
  timeblockPositions: TimeblockPosition[];
  timeblocksByDate: Map<string, CalendarDisplayEvent[]>;
}

/**
 * 複数日表示用のタイムブロック位置計算フック
 * MultiDayView(3day/5day等)で共通利用
 *
 * useTimeblockLayoutCalculatorを使用して重複タイムブロックの
 * カラム配置を正しく計算
 */
export function useMultiDayTimeblockPositions({
  displayDates,
  timeblocks,
  hourHeight = DEFAULT_HOUR_HEIGHT,
  timezone,
}: UseMultiDayTimeblockPositionsOptions): UseMultiDayTimeblockPositionsReturn {
  // 日付別にタイムブロックをグループ化（raw startDate + ユーザーTZの日付キーで判定）
  const timeblocksByDate = useMemo(() => {
    const grouped = new Map<string, CalendarDisplayEvent[]>();

    displayDates.forEach((date) => {
      const dateKey = getDateKey(date, timezone);
      const dayTimeblocks = timeblocks.filter((timeblock) => {
        if (
          !timeblock.startDate ||
          !timeblock.displayStartDate ||
          !isValid(new Date(timeblock.displayStartDate))
        ) {
          return false;
        }
        return getDateKey(timeblock.startDate, timezone) === dateKey;
      });
      grouped.set(dateKey, dayTimeblocks);
    });

    return grouped;
  }, [displayDates, timeblocks, timezone]);

  // 全日付のタイムブロックをTimedTimeblock形式に変換（useTimeblockLayoutCalculator用）
  // displayStartDate/displayEndDateを使用してTZ対応の位置計算を実現
  const allConvertedTimeblocks = useMemo(() => {
    const converted: Array<{
      dateKey: string;
      timeblock: CalendarDisplayEvent;
      start: Date;
      end: Date;
      id: string;
    }> = [];

    timeblocksByDate.forEach((dayTimeblocks, dateKey) => {
      dayTimeblocks.forEach((timeblock) => {
        converted.push({
          dateKey,
          timeblock,
          start: timeblock.displayStartDate,
          end:
            timeblock.displayEndDate ||
            new Date(timeblock.displayStartDate.getTime() + 60 * 60 * 1000),
          id: timeblock.id,
        });
      });
    });

    return converted;
  }, [timeblocksByDate]);

  // O(1)ルックアップ用Map（allConvertedTimeblocks.find() の O(n*m) を回避）
  const timeblockMap = useMemo(() => {
    const map = new Map<string, CalendarDisplayEvent>();
    for (const item of allConvertedTimeblocks) {
      map.set(item.id, item.timeblock);
    }
    return map;
  }, [allConvertedTimeblocks]);

  // 日付ごとにレイアウト計算
  // useTimeblockLayoutCalculatorはフックなので、日付ごとに呼べない
  // 代わりに全タイムブロックを一度に渡し、後で日付ごとに分離
  const timeblockLayouts = useTimeblockLayoutCalculator(
    allConvertedTimeblocks.map((p) => ({
      ...p.timeblock,
      start: p.start,
      end: p.end,
      id: p.id,
    })),
  );

  // レイアウト情報をTimeblockPositionに変換
  const timeblockPositions = useMemo((): TimeblockPosition[] => {
    return timeblockLayouts.map((layout: TimeblockLayout, index: number) => {
      const timeblock =
        timeblockMap.get(layout.timeblock.id) ?? (layout.timeblock as CalendarDisplayEvent);
      const { top, height } = layoutTimeblockToVerticalPosition(
        new Date(layout.timeblock.start),
        new Date(layout.timeblock.end),
        hourHeight,
      );

      return {
        plan: timeblock,
        top,
        height,
        left: layout.left,
        width: layout.width,
        zIndex: getTimeblockStackIndex(timeblock, index),
        column: layout.column,
        totalColumns: layout.totalColumns,
        opacity: layout.totalColumns > 1 ? 0.95 : 1.0,
      };
    });
  }, [timeblockLayouts, timeblockMap, hourHeight]);

  return {
    timeblockPositions,
    timeblocksByDate,
  };
}
