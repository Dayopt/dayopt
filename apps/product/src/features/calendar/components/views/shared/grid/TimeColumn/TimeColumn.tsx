/**
 * 時間列コンポーネント（左側の時間表示）
 * Googleカレンダー風のフレックス構造
 */

'use client';

import { memo, useMemo } from 'react';

import { cn } from '@dayopt/components';

import { resolveTimeColumnWidth } from '../../constants/grid.constants';

import type { TimeColumnProps } from '../../../../../types/grid.types';

/**
 * 時間ラベルをフォーマット
 */
function formatHourLabel(hour: number, format: '12h' | '24h'): string {
  if (format === '24h') {
    return `${String(hour).padStart(2, '0')}:00`;
  }
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${h}:00 ${ampm}`;
}

/** 現在時刻バッジ（text-xs + py-1 ≒ 24px）と時刻ラベルが重なる縦距離の目安（px） */
const OCCLUSION_RADIUS_PX = 24;

/**
 * 現在時刻バッジと重なる時刻ラベルかどうか。Google / Apple Calendar と同じく、
 * バッジが乗る時刻ラベルは描かずバッジだけを読ませる
 */
export function isHourLabelOccluded(
  hour: number,
  occludedMinutes: number | null | undefined,
  hourHeight: number,
): boolean {
  if (occludedMinutes == null) return false;
  const distancePx = (Math.abs(hour * 60 - occludedMinutes) / 60) * hourHeight;
  return distancePx < OCCLUSION_RADIUS_PX;
}

export const TimeColumn = memo<TimeColumnProps>(function TimeColumn({
  startHour = 0,
  endHour = 24,
  hourHeight = 72,
  format = '24h',
  className = '',
  width,
  dense = false,
  occludedMinutes,
}) {
  // 幅は表記と密度で決まる。明示指定が無ければ同じ規則から解く
  const resolvedWidth = width ?? resolveTimeColumnWidth(format, dense);

  // グリッド高さ
  const gridHeight = (endHour - startHour) * hourHeight;

  // 時間行を生成
  const timeRows = useMemo(() => {
    const rows: React.ReactNode[] = [];
    for (let hour = startHour; hour < endHour; hour++) {
      const label = formatHourLabel(hour, format);
      // 0時と折りたたみ時の最初の時間、現在時刻バッジが重なる時間はラベルを表示しない
      const showLabel =
        hour !== 0 &&
        !(hour === startHour && startHour > 0) &&
        !isHourLabelOccluded(hour, occludedMinutes, hourHeight);

      const textClass = 'text-muted-foreground';

      rows.push(
        <div
          key={`hour-${hour}`}
          className={cn(
            // px-2: ラベルは右詰めだが、左をグリッド端に接触させない（左右 8px）
            'relative flex w-full items-start justify-end px-2 tabular-nums select-none',
            dense ? 'text-xs' : 'text-sm',
            textClass,
          )}
          style={{ height: `${hourHeight}px` }}
        >
          {showLabel && <span className="-translate-y-1/2">{label}</span>}
        </div>,
      );
    }

    return rows;
  }, [startHour, endHour, hourHeight, format, dense, occludedMinutes]);

  return (
    <div
      className={cn('sticky left-0 z-10 flex flex-col', className)}
      style={{
        width: `${resolvedWidth}px`,
        height: `${gridHeight}px`,
      }}
    >
      {timeRows}
    </div>
  );
});
