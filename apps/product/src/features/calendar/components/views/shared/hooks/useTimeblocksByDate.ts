/**
 * タイムブロック日付グループ化統一フック
 */

import { useMemo } from 'react';

import { getDateKey } from '@/lib/date';
import type { CalendarDisplayEvent } from '../../../../types/base.types';
import { isValidEvent } from '../utils/dateHelpers';
import { sortAgendaEventsByDateKeys, sortEventsByDateKeys } from '../utils/timeblockSorting';

/** useTimeblocksByDate フックのオプション */
interface UseTimeblocksByDateOptions {
  dates: Date[];
  timeblocks: CalendarDisplayEvent[];
  sortType?: 'standard' | 'agenda';
  timezone?: string;
}

/** useTimeblocksByDate フックの戻り値 */
interface UseTimeblocksByDateReturn {
  timeblocksByDate: Record<string, CalendarDisplayEvent[]>;
  totalTimeblocks: number;
  hasTimeblocks: boolean;
}

/**
 * タイムブロックを日付ごとにグループ化する統一フック
 *
 * @description
 * 以前は各ビューで80-90行の重複ロジックがあったが、これで統一
 * - WeekView, ThreeDayView, FiveDayView で共通使用
 * - マルチデイタイムブロック対応
 * - 無効タイムブロックの自動フィルタリング
 * - 時刻ソート
 */
export function useTimeblocksByDate({
  dates,
  timeblocks = [],
  sortType = 'standard',
  timezone,
}: UseTimeblocksByDateOptions): UseTimeblocksByDateReturn {
  const timeblocksByDate = useMemo(() => {
    const grouped: Record<string, CalendarDisplayEvent[]> = {};

    // Step 1: 各日付のキーを初期化
    dates.forEach((date) => {
      const dateKey = getDateKey(date, timezone);
      grouped[dateKey] = [];
    });

    // Step 2: タイムブロックを適切な日付に配置
    timeblocks.forEach((timeblock) => {
      if (!isValidEvent(timeblock)) {
        return;
      }

      // startDateがnullまたはundefinedの場合はスキップ
      if (!timeblock.startDate) {
        return;
      }

      // より柔軟な日付正規化
      const timeblockStart =
        timeblock.startDate instanceof Date ? timeblock.startDate : new Date(timeblock.startDate);

      // 無効な日付は除外
      if (isNaN(timeblockStart.getTime())) {
        return;
      }

      // マルチデイタイムブロックの場合は複数日にまたがって表示
      if (timeblock.isMultiDay && timeblock.endDate) {
        const timeblockEnd =
          timeblock.endDate instanceof Date ? timeblock.endDate : new Date(timeblock.endDate);

        if (!isNaN(timeblockEnd.getTime())) {
          const startKey = getDateKey(timeblockStart, timezone);
          const endKey = getDateKey(timeblockEnd, timezone);
          // 期間内の日付のみ処理
          dates.forEach((date) => {
            const dateKey = getDateKey(date, timezone);
            if (dateKey >= startKey && dateKey <= endKey) {
              if (grouped[dateKey]) {
                grouped[dateKey].push(timeblock);
              }
            }
          });
          return;
        }
      }

      // 単日タイムブロックの場合
      const timeblockDateKey = getDateKey(timeblockStart, timezone);
      dates.forEach((date) => {
        const dateKey = getDateKey(date, timezone);
        if (timeblockDateKey === dateKey) {
          if (grouped[dateKey]) {
            grouped[dateKey].push(timeblock);
          }
        }
      });
    });

    // Step 3: 各日のタイムブロックを適切にソート
    const sortedResult =
      sortType === 'agenda' ? sortAgendaEventsByDateKeys(grouped) : sortEventsByDateKeys(grouped);

    return sortedResult;
  }, [dates, timeblocks, sortType, timezone]);

  // 統計情報も提供
  const totalTimeblocks = useMemo(() => {
    return Object.values(timeblocksByDate).reduce(
      (total, dayTimeblocks) => total + dayTimeblocks.length,
      0,
    );
  }, [timeblocksByDate]);

  const hasTimeblocks = totalTimeblocks > 0;

  return {
    timeblocksByDate,
    totalTimeblocks,
    hasTimeblocks,
  };
}
