import type {
  UseDayTimeblocksOptions,
  UseDayTimeblocksReturn,
} from '../../../../types/day-view.types';
import { useResponsiveHourHeight } from '../../shared/hooks/useResponsiveHourHeight';
import { useViewTimeblocks } from '../../shared/hooks/useViewTimeblocks';

/**
 * DayView用のタイムブロック処理フック
 * 共通のuseViewTimeblocksを使用
 */
export function useDayTimeblocks({
  date,
  timeblocks,
  timezone,
}: UseDayTimeblocksOptions): UseDayTimeblocksReturn {
  const hourHeight = useResponsiveHourHeight();
  return useViewTimeblocks({ date, timeblocks, hourHeight, timezone });
}
