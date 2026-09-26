import { describe, expect, it } from 'vitest';

import type { InteractionState } from '../../../../interaction';

import { getAdjustedStyle, getPreviewTime } from './interactionHelpers';

const idle: InteractionState = { mode: 'idle' };

const dragging: InteractionState = {
  mode: 'dragging',
  timeblockId: 'plan-1',
  startPoint: { clientX: 0, clientY: 0 },
  currentPoint: { clientX: 100, clientY: 200 },
  originalPosition: { top: 0, height: 60, left: 0, width: 100 },
  dateIndex: 0,
  targetDateIndex: 0,
  snappedTop: 60,
  previewTime: {
    start: new Date('2026-04-27T01:00:00.000Z'),
    end: new Date('2026-04-27T02:00:00.000Z'),
  },
  isOverlapping: false,
};

const resizingPreviewTime = {
  start: new Date('2026-04-27T01:00:00.000Z'),
  end: new Date('2026-04-27T03:00:00.000Z'),
};
const resizing: Extract<InteractionState, { mode: 'resizing' }> = {
  mode: 'resizing',
  timeblockId: 'plan-1',
  startPoint: { clientX: 0, clientY: 0 },
  currentPoint: { clientX: 0, clientY: 100 },
  originalPosition: { top: 0, height: 60, left: 0, width: 100 },
  direction: 'bottom',
  snappedTop: 10,
  snappedHeight: 120,
  previewTime: resizingPreviewTime,
  isOverlapping: false,
};

const baseStyle: React.CSSProperties = {
  top: 0,
  height: 60,
  background: 'red',
};

describe('getAdjustedStyle', () => {
  it('idle 状態では元のスタイルをそのまま返す', () => {
    const result = getAdjustedStyle(baseStyle, 'plan-1', idle);
    expect(result).toEqual(baseStyle);
  });

  describe('dragging', () => {
    it('対象 plan には opacity=0.3 / zIndex=1 を付与', () => {
      const result = getAdjustedStyle(baseStyle, 'plan-1', dragging);
      expect(result).toMatchObject({
        ...baseStyle,
        opacity: 0.3,
        zIndex: 1,
      });
    });

    it('別の plan は影響を受けない（元スタイルそのまま）', () => {
      const result = getAdjustedStyle(baseStyle, 'plan-2', dragging);
      expect(result).toEqual(baseStyle);
      expect(result).not.toHaveProperty('opacity');
    });
  });

  describe('resizing', () => {
    it('対象 plan には snappedHeight を反映 / zIndex=1000 を付与', () => {
      const result = getAdjustedStyle(baseStyle, 'plan-1', resizing);
      expect(result).toMatchObject({
        ...baseStyle,
        top: 10,
        height: '120px',
        zIndex: 1000,
      });
    });

    it('別の plan は影響を受けない', () => {
      const result = getAdjustedStyle(baseStyle, 'plan-2', resizing);
      expect(result).toEqual(baseStyle);
    });
  });

  it('元のスタイル を mutate しない', () => {
    const original = { ...baseStyle };
    getAdjustedStyle(original, 'plan-1', dragging);
    expect(original).toEqual(baseStyle);
  });
});

describe('getPreviewTime', () => {
  it('idle / dragging では null を返す（resize 時のみ表示）', () => {
    expect(getPreviewTime('plan-1', idle)).toBeNull();
    expect(getPreviewTime('plan-1', dragging)).toBeNull();
  });

  it('resizing 中で対象 plan なら previewTime を返す', () => {
    const result = getPreviewTime('plan-1', resizing);
    expect(result).toEqual(resizing.previewTime);
  });

  it('resizing 中でも別 plan の場合は null', () => {
    expect(getPreviewTime('plan-2', resizing)).toBeNull();
  });
});
