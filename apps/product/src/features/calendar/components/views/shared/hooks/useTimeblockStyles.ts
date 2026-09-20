import type { CSSProperties } from 'react';
import { useMemo } from 'react';

import { computeTimeblockStyles } from '../../../../lib/grid';

import type { TimeblockPosition } from './useViewTimeblocks';

/**
 * タイムブロック位置情報からCSSスタイルを計算するフック
 * engine/grid.ts の computeTimeblockStyles の React ラッパー
 */
export function useTimeblockStyles(
  timeblockPositions: TimeblockPosition[],
): Record<string, CSSProperties> {
  return useMemo((): Record<string, CSSProperties> => {
    const inputs = timeblockPositions
      .filter((p) => p.plan?.id)
      .map(({ plan, top, height, left, width, zIndex, opacity }) => ({
        id: plan.id,
        top,
        height,
        left,
        width,
        zIndex,
        ...(opacity != null ? { opacity } : {}),
      }));

    return computeTimeblockStyles(inputs);
  }, [timeblockPositions]);
}
