/**
 * カレンダーグリッドのレイアウト計算
 *
 * ScrollableCalendarLayout から抽出したカスタムフック。
 * 24 時間分のグリッド高さと、表示範囲における今日の列位置を返す。
 *
 * 旧名は `useSleepHoursLayout` だったが、睡眠時間帯の描画も睡眠設定の読み取りも
 * 行っていない（睡眠スケジュールは実装されたことがなく、参照の無い文言キーだけが
 * 残っていた。同じ変更で削除した）。名前が嘘をつかないよう改名した（2026-09-13）。
 */

import { useMemo } from 'react';

import { HOURS_PER_DAY } from '../constants/grid.constants';

/** 今日の列位置情報 */
interface TodayColumnPosition {
  left: string | number;
  width: string;
}

/** useCalendarGridLayout フックのオプション */
interface UseCalendarGridLayoutOptions {
  hourHeight: number;
  displayDates?: Date[] | undefined;
}

/** useCalendarGridLayout フックの戻り値 */
interface UseCalendarGridLayoutReturn {
  gridHeight: number;
  todayColumnPosition: TodayColumnPosition | null;
  hasToday: boolean;
}

export const useCalendarGridLayout = ({
  hourHeight,
  displayDates = [],
}: UseCalendarGridLayoutOptions): UseCalendarGridLayoutReturn => {
  // グリッド高さ
  const gridHeight = HOURS_PER_DAY * hourHeight;

  // 今日の列の位置を計算
  const todayColumnPosition = useMemo((): TodayColumnPosition | null => {
    if (displayDates.length === 0) {
      return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 今日のインデックスを見つける
    const todayIndex = displayDates.findIndex((date) => {
      if (!date) return false;
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      return d.getTime() === today.getTime();
    });

    if (todayIndex === -1) {
      return null;
    }

    // 単一日表示の場合
    if (displayDates.length === 1) {
      return {
        left: 0,
        width: '100%',
      };
    }

    // 複数日表示の場合、列の幅と位置を計算
    const columnWidth = 100 / displayDates.length; // パーセント
    const leftPosition = todayIndex * columnWidth; // パーセント

    return {
      left: `${leftPosition}%`,
      width: `${columnWidth}%`,
    };
  }, [displayDates]);

  // 今日が表示範囲に含まれるか
  const hasToday = todayColumnPosition !== null;

  return {
    gridHeight,
    todayColumnPosition,
    hasToday,
  };
};
