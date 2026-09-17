import { useMemo } from 'react';

import { isValid } from 'date-fns';

import { getDateKey } from '@/lib/date';
import { layoutTimeblockToVerticalPosition } from '../../../../lib/grid';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import { HOUR_HEIGHT } from '../constants/grid.constants';
import { getTimeblockStackIndex } from '../utils/timeblockStacking';

import { useTimeblockLayoutCalculator, type TimeblockLayout } from './useTimeblockLayoutCalculator';

interface UseViewTimeblocksOptions {
  date: Date;
  timeblocks: CalendarDisplayEvent[];
  hourHeight?: number;
  timezone: string;
}

/** グリッド上のタイムブロック描画位置情報 */
export interface TimeblockPosition {
  plan: CalendarDisplayEvent;
  top: number;
  height: number;
  left: number;
  width: number;
  zIndex: number;
  column: number;
  totalColumns: number;
  opacity?: number;
}

interface UseViewTimeblocksReturn {
  dayTimeblocks: CalendarDisplayEvent[];
  timeblockPositions: TimeblockPosition[];
  maxConcurrentTimeblocks: number;
  skippedTimeblocksCount: number;
}

/**
 * 汎用的なビュータイムブロック処理フック
 * DayView, WeekView等で共通利用可能
 */
/** 指定日のタイムブロックをフィルタ・配置計算するフック（DayView/WeekView等で共通利用） */
export function useViewTimeblocks({
  date,
  timeblocks = [],
  hourHeight = HOUR_HEIGHT,
  timezone,
}: UseViewTimeblocksOptions): UseViewTimeblocksReturn {
  // 指定日のタイムブロックのみフィルター（raw startDate + ユーザーTZの日付キーで判定）
  const dayTimeblocks = useMemo(() => {
    if (!timeblocks || !Array.isArray(timeblocks)) {
      return [];
    }
    const dateKey = getDateKey(date, timezone);
    const result = timeblocks.filter((timeblock) => {
      if (
        !timeblock.startDate ||
        !timeblock.displayStartDate ||
        !isValid(new Date(timeblock.displayStartDate))
      ) {
        return false;
      }

      return getDateKey(timeblock.startDate, timezone) === dateKey;
    });

    return result;
  }, [date, timeblocks, timezone]);

  // CalendarDisplayEventをuseTimeblockLayoutCalculatorで期待される形式に変換
  // displayStartDate/displayEndDateを使用してTZ対応の位置計算を実現
  const convertedTimeblocks = useMemo(() => {
    return dayTimeblocks.map((timeblock) => ({
      ...timeblock,
      start: timeblock.displayStartDate,
      end:
        timeblock.displayEndDate || new Date(timeblock.displayStartDate.getTime() + 60 * 60 * 1000),
    }));
  }, [dayTimeblocks]);

  // 新しいレイアウト計算システムを使用
  const timeblockLayouts = useTimeblockLayoutCalculator(convertedTimeblocks);

  // レイアウト情報をTimeblockPositionに変換
  const timeblockPositions = useMemo((): TimeblockPosition[] => {
    return timeblockLayouts.map((layout: TimeblockLayout, index: number) => {
      const { top, height } = layoutTimeblockToVerticalPosition(
        new Date(layout.timeblock.start),
        new Date(layout.timeblock.end),
        hourHeight,
      );

      return {
        plan: layout.timeblock as CalendarDisplayEvent,
        top,
        height,
        left: layout.left,
        width: layout.width,
        zIndex: getTimeblockStackIndex(layout.timeblock as CalendarDisplayEvent, index),
        column: layout.column,
        totalColumns: layout.totalColumns,
        opacity: layout.totalColumns > 1 ? 0.95 : 1.0,
      };
    });
  }, [timeblockLayouts, hourHeight]);

  const maxConcurrentTimeblocks = useMemo(() => {
    return Math.max(1, ...timeblockLayouts.map((layout: TimeblockLayout) => layout.totalColumns));
  }, [timeblockLayouts]);

  return {
    dayTimeblocks,
    timeblockPositions,
    maxConcurrentTimeblocks,
    skippedTimeblocksCount: 0, // 新しいシステムではスキップしない
  };
}
