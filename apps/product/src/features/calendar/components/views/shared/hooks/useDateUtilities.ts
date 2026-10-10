/**
 * 日付生成ユーティリティ統一フック
 * 各ビューで重複していた日付配列生成ロジックを統合
 */

import { useMemo } from 'react';

import { addDays, startOfWeek } from '@/lib/date';

import { generateMultiDayDates } from '../../../../domain/view-range';

/** useDateUtilities フックのオプション */
interface UseDateUtilitiesOptions {
  referenceDate: Date;
  viewType: 'week' | 'threeday' | 'fiveday' | 'multiday';
  weekStartsOn?: 0 | 1 | 6;
  showWeekends?: boolean;
  dayCount?: number; // multiday用の表示日数（2-7）
}

/** useDateUtilities フックの戻り値 */
interface UseDateUtilitiesReturn {
  dates: Date[];
  startDate: Date;
  endDate: Date;
  dateCount: number;
}

/**
 * ビュー別日付配列生成の統一フック
 *
 * @description
 * 全てのビューで「完全な日付配列を生成→週末フィルタリング」の統一アプローチを採用
 * これにより週末表示設定に関係なく一貫した動作を保証
 * - WeekView: 週の7日間
 * - MultiDayView(3day): 中央日±1日の3日間
 * - MultiDayView(5day): 中央日±2日の5日間
 * - MultiDayView: 中央日±floor(dayCount/2)日のN日間（2-7日）
 */
export function useDateUtilities({
  referenceDate,
  viewType,
  weekStartsOn = 0,
  showWeekends = true,
  dayCount,
}: UseDateUtilitiesOptions): UseDateUtilitiesReturn {
  const dates = useMemo(() => {
    // Step 1: 各ビューに応じた完全な日付配列を生成
    let fullDates: Date[] = [];

    // multiday / threeday / fiveday を統一処理
    const effectiveDayCount =
      viewType === 'multiday'
        ? (dayCount ?? 3)
        : viewType === 'threeday'
          ? 3
          : viewType === 'fiveday'
            ? 5
            : null;

    if (effectiveDayCount !== null) {
      fullDates = generateMultiDayDates(referenceDate, effectiveDayCount, showWeekends);
    } else {
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- #3094 で assertNever 化
      switch (viewType) {
        case 'week': {
          // 週の開始日を計算して7日間すべて生成
          const weekStart = startOfWeek(referenceDate, { weekStartsOn });
          fullDates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
          break;
        }

        default:
          fullDates = [referenceDate];
      }
    }

    // Step 2: 週末フィルタリングを統一的に適用
    // multiday/threeday/fivedayビューは既に処理済みなので、他のビューのみフィルタリング
    if (
      !showWeekends &&
      viewType !== 'threeday' &&
      viewType !== 'fiveday' &&
      viewType !== 'multiday'
    ) {
      return fullDates.filter((date) => {
        const day = date.getDay();
        return day !== 0 && day !== 6; // 日曜(0)、土曜(6)を除外
      });
    }

    return fullDates;
  }, [referenceDate, viewType, weekStartsOn, showWeekends, dayCount]);

  const startDate = useMemo(() => dates[0]!, [dates]);
  const endDate = useMemo(() => dates[dates.length - 1]!, [dates]);
  const dateCount = dates.length;

  return {
    dates,
    startDate,
    endDate,
    dateCount,
  };
}
