import { useMemo } from 'react';

import { isValid } from 'date-fns';

import { getDateKey } from '@/lib/date';
import { layoutEntryToVerticalPosition } from '../../../../lib/grid';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import { HOUR_HEIGHT as DEFAULT_HOUR_HEIGHT } from '../constants/grid.constants';
import { getTimeblockStackIndex } from '../utils/timeblockStacking';

import { useTimeblockLayoutCalculator, type TimeblockLayout } from './useTimeblockLayoutCalculator';
import type { TimeblockPosition } from './useViewTimeblocks';

/** useMultiDayTimeblockPositions フックのオプション */
interface UseMultiDayEntryPositionsOptions {
  displayDates: Date[];
  entries: CalendarDisplayEvent[];
  hourHeight?: number;
  timezone: string;
}

/** useMultiDayTimeblockPositions フックの戻り値 */
interface UseMultiDayEntryPositionsReturn {
  timeblockPositions: TimeblockPosition[];
  entriesByDate: Map<string, CalendarDisplayEvent[]>;
}

/**
 * 複数日表示用のエントリ位置計算フック
 * MultiDayView(3day/5day等)で共通利用
 *
 * useTimeblockLayoutCalculatorを使用して重複エントリの
 * カラム配置を正しく計算
 */
export function useMultiDayTimeblockPositions({
  displayDates,
  entries,
  hourHeight = DEFAULT_HOUR_HEIGHT,
  timezone,
}: UseMultiDayEntryPositionsOptions): UseMultiDayEntryPositionsReturn {
  // 日付別にエントリをグループ化（raw startDate + ユーザーTZの日付キーで判定）
  const entriesByDate = useMemo(() => {
    const grouped = new Map<string, CalendarDisplayEvent[]>();

    displayDates.forEach((date) => {
      const dateKey = getDateKey(date, timezone);
      const dayEntries = entries.filter((entry) => {
        if (
          !entry.startDate ||
          !entry.displayStartDate ||
          !isValid(new Date(entry.displayStartDate))
        ) {
          return false;
        }
        return getDateKey(entry.startDate, timezone) === dateKey;
      });
      grouped.set(dateKey, dayEntries);
    });

    return grouped;
  }, [displayDates, entries, timezone]);

  // 全日付のエントリをTimedTimeblock形式に変換（useTimeblockLayoutCalculator用）
  // displayStartDate/displayEndDateを使用してTZ対応の位置計算を実現
  const allConvertedEntries = useMemo(() => {
    const converted: Array<{
      dateKey: string;
      entry: CalendarDisplayEvent;
      start: Date;
      end: Date;
      id: string;
    }> = [];

    entriesByDate.forEach((dayEntries, dateKey) => {
      dayEntries.forEach((entry) => {
        converted.push({
          dateKey,
          entry,
          start: entry.displayStartDate,
          end: entry.displayEndDate || new Date(entry.displayStartDate.getTime() + 60 * 60 * 1000),
          id: entry.id,
        });
      });
    });

    return converted;
  }, [entriesByDate]);

  // O(1)ルックアップ用Map（allConvertedEntries.find() の O(n*m) を回避）
  const timeblockMap = useMemo(() => {
    const map = new Map<string, CalendarDisplayEvent>();
    for (const item of allConvertedEntries) {
      map.set(item.id, item.entry);
    }
    return map;
  }, [allConvertedEntries]);

  // 日付ごとにレイアウト計算
  // useTimeblockLayoutCalculatorはフックなので、日付ごとに呼べない
  // 代わりに全エントリを一度に渡し、後で日付ごとに分離
  const timeblockLayouts = useTimeblockLayoutCalculator(
    allConvertedEntries.map((p) => ({
      ...p.entry,
      start: p.start,
      end: p.end,
      id: p.id,
    })),
  );

  // レイアウト情報をTimeblockPositionに変換
  const timeblockPositions = useMemo((): TimeblockPosition[] => {
    return timeblockLayouts.map((layout: TimeblockLayout, index: number) => {
      const entry =
        timeblockMap.get(layout.timeblock.id) ?? (layout.timeblock as CalendarDisplayEvent);
      const { top, height } = layoutEntryToVerticalPosition(
        new Date(layout.timeblock.start),
        new Date(layout.timeblock.end),
        hourHeight,
      );

      return {
        plan: entry,
        top,
        height,
        left: layout.left,
        width: layout.width,
        zIndex: getTimeblockStackIndex(entry, index),
        column: layout.column,
        totalColumns: layout.totalColumns,
        opacity: layout.totalColumns > 1 ? 0.95 : 1.0,
      };
    });
  }, [timeblockLayouts, timeblockMap, hourHeight]);

  return {
    timeblockPositions,
    entriesByDate,
  };
}
