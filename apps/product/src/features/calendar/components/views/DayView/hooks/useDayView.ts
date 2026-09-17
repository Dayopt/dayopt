import type { UseDayViewOptions, UseDayViewReturn } from '../../../../types/day-view.types';
import { useIsToday } from '../../shared/hooks/useIsToday';
import { useTimeblockStyles } from '../../shared/hooks/useTimeblockStyles';
import { useTimeSlots } from '../../shared/hooks/useTimeSlots';

import { useDayTimeblocks } from './useDayTimeblocks';

/** DayView のタイムブロック取得・スタイル計算・今日判定を集約したフック */
export function useDayView({
  date,
  timeblocks,
  onTimeblockUpdate: _onTimeblockUpdate,
  timezone,
}: UseDayViewOptions): UseDayViewReturn {
  // タイムブロックデータ処理
  const { dayTimeblocks, timeblockPositions } = useDayTimeblocks({ date, timeblocks, timezone });

  // 今日かどうかの判定
  const isTodayFlag = useIsToday(date);

  // 時間スロットの生成（0:00-23:45、15分間隔）
  const timeSlots = useTimeSlots();

  // タイムブロックのCSSスタイルを計算
  const timeblockStyles = useTimeblockStyles(timeblockPositions);

  // スクロール処理はScrollableCalendarLayoutに委譲

  return {
    dayTimeblocks,
    timeblockStyles,
    isToday: isTodayFlag,
    timeSlots,
  };
}
