/**
 * Interaction State Machine tests — snapToGrid と精度・日端境界の回帰
 */

import { describe, expect, it } from 'vitest';

import { IDLE, snapToGrid } from './machine';
import { createCtx, dispatch, origin } from './machine-test-helpers';
import type { InteractionState, TimeblockRect } from './types';

// ========================================
// snapToGrid
// ========================================

describe('snapToGrid', () => {
  it('snaps exact grid positions unchanged', () => {
    // 9:00 = 540px at 60px/h
    expect(snapToGrid(540, 60)).toEqual({ snappedTop: 540, hour: 9, minute: 0 });
  });

  it('default snap は 15 分粒度（9:07 → 9:00）', () => {
    // 9:07 = 547px
    expect(snapToGrid(547, 60)).toEqual({ snappedTop: 540, hour: 9, minute: 0 });
  });

  it('interval=15 明示で 9:07 → 9:00', () => {
    // 9:07 = 547px
    expect(snapToGrid(547, 60, 15)).toEqual({ snappedTop: 540, hour: 9, minute: 0 });
  });

  it('interval=15 明示で 9:08 → 9:15', () => {
    // 9:08 = 548px
    expect(snapToGrid(548, 60, 15)).toEqual({ snappedTop: 555, hour: 9, minute: 15 });
  });

  it('snaps 9:52 → 9:45', () => {
    // 9:52 = 592px
    expect(snapToGrid(592, 60, 15)).toEqual({ snappedTop: 585, hour: 9, minute: 45 });
  });

  it('snaps 9:53 → 10:00', () => {
    // 9:53 = 593px
    expect(snapToGrid(593, 60, 15)).toEqual({ snappedTop: 600, hour: 10, minute: 0 });
  });

  it('当日最後のグリッド（23:45）でクランプする', () => {
    // 24:00 へ丸まっても 23:00 まで巻き戻さない
    expect(snapToGrid(9999, 60)).toEqual({ snappedTop: 1425, hour: 23, minute: 45 });
  });

  it('clamps to 0:00 min', () => {
    expect(snapToGrid(-10, 60)).toEqual({ snappedTop: 0, hour: 0, minute: 0 });
  });

  it('supports custom interval (30 min)', () => {
    // 9:20 → 9:30
    expect(snapToGrid(560, 60, 30)).toEqual({ snappedTop: 570, hour: 9, minute: 30 });
  });
});
describe('precision regression: 移動 / リサイズは相対 snap で元の分を保持する', () => {
  // 10:07 entry を表す originalPosition: top=607（hourHeight=60 で 10*60+7=607）
  const off607: TimeblockRect = { top: 607, left: 0, width: 200, height: 60 };

  it('LONGPRESS_FIRED on 10:07 entry → preview start keeps 10:07（移動量ゼロ）', () => {
    const longpressState: InteractionState = {
      mode: 'longpress-pending',
      timeblockId: 'a',
      startPoint: origin,
      originalPosition: off607,
      dateIndex: 0,
    };
    const { state } = dispatch(longpressState, { type: 'LONGPRESS_FIRED' });

    expect(state.mode).toBe('dragging');
    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(607);
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(7);
    }
  });

  it('drag 10:07 → +30px → 10:37（相対 snap で :07 を保持し 10:15 へ潰さない）', () => {
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off607,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 607,
      previewTime: {
        start: new Date('2026-01-15T10:07:00'),
        end: new Date('2026-01-15T11:07:00'),
      },
      isOverlapping: false,
    };
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 30 };
    const { state } = dispatch(draggingState, { type: 'POINTER_MOVE', point: movedPoint });

    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(637);
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(37);
    }
  });

  it('drag 10:07 → +7px → 動かない（15 分未満の移動量は 0 に量子化）', () => {
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off607,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 607,
      previewTime: {
        start: new Date('2026-01-15T10:07:00'),
        end: new Date('2026-01-15T11:07:00'),
      },
      isOverlapping: false,
    };
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 7 };
    const { state } = dispatch(draggingState, { type: 'POINTER_MOVE', point: movedPoint });

    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(607);
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(7);
    }
  });

  it('drag 10:07 → +8px → 10:22（15 分ぶん動き、:07 のオフセットは残る）', () => {
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off607,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 607,
      previewTime: {
        start: new Date('2026-01-15T10:07:00'),
        end: new Date('2026-01-15T11:07:00'),
      },
      isOverlapping: false,
    };
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 8 };
    const { state } = dispatch(draggingState, { type: 'POINTER_MOVE', point: movedPoint });

    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(622);
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(22);
      expect(state.previewTime.end.getHours()).toBe(11);
      expect(state.previewTime.end.getMinutes()).toBe(22);
    }
  });

  it('5分snap設定でも移動量ゼロなら15:13のまま（絶対グリッドへ吸着しない）', () => {
    const off913: TimeblockRect = { top: 913, left: 0, width: 200, height: 60 };
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off913,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 913,
      previewTime: {
        start: new Date('2026-01-15T15:13:00'),
        end: new Date('2026-01-15T16:13:00'),
      },
      isOverlapping: false,
    };
    const { state } = dispatch(
      draggingState,
      { type: 'POINTER_MOVE', point: origin },
      createCtx({ snapIntervalMinutes: 5 }),
    );

    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(913);
      expect(state.previewTime.start.getHours()).toBe(15);
      expect(state.previewTime.start.getMinutes()).toBe(13);
      expect(state.previewTime.end.getHours()).toBe(16);
      expect(state.previewTime.end.getMinutes()).toBe(13);
    }
  });

  it('移動では duration を丸めない（47 分 entry は 47 分のまま動く）', () => {
    const off913: TimeblockRect = { top: 913, left: 0, width: 200, height: 47 };
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off913,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 913,
      previewTime: {
        start: new Date('2026-01-15T15:13:00'),
        end: new Date('2026-01-15T16:00:00'),
      },
      isOverlapping: false,
    };
    const { state } = dispatch(
      draggingState,
      { type: 'POINTER_MOVE', point: origin },
      createCtx({
        snapIntervalMinutes: 5,
        getTimeblockDurationMs: () => 47 * 60 * 1000,
      }),
    );

    if (state.mode === 'dragging') {
      const durationMs = state.previewTime.end.getTime() - state.previewTime.start.getTime();
      expect(state.previewTime.start.getHours()).toBe(15);
      expect(state.previewTime.start.getMinutes()).toBe(13);
      expect(state.previewTime.end.getHours()).toBe(16);
      expect(state.previewTime.end.getMinutes()).toBe(0);
      expect(durationMs).toBe(47 * 60 * 1000);
    }
  });

  it('移動では終了境界も snap しない（48分entryは48分のまま）', () => {
    const off913: TimeblockRect = { top: 913, left: 0, width: 200, height: 48 };
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off913,
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 913,
      previewTime: {
        start: new Date('2026-01-15T15:13:00'),
        end: new Date('2026-01-15T16:01:00'),
      },
      isOverlapping: false,
    };
    const { state } = dispatch(
      draggingState,
      { type: 'POINTER_MOVE', point: origin },
      createCtx({
        snapIntervalMinutes: 5,
        getTimeblockDurationMs: () => 48 * 60 * 1000,
      }),
    );

    if (state.mode === 'dragging') {
      const durationMs = state.previewTime.end.getTime() - state.previewTime.start.getTime();
      expect(state.previewTime.start.getHours()).toBe(15);
      expect(state.previewTime.start.getMinutes()).toBe(13);
      expect(state.previewTime.end.getHours()).toBe(16);
      expect(state.previewTime.end.getMinutes()).toBe(1);
      expect(durationMs).toBe(48 * 60 * 1000);
    }
  });

  it('RESIZE_START on 10:07 entry → preview range keeps 10:07-11:07（掴んだだけでは動かない）', () => {
    const { state } = dispatch(IDLE, {
      type: 'RESIZE_START',
      timeblockId: 'a',
      direction: 'bottom',
      point: origin,
      originalPosition: off607,
    });

    if (state.mode === 'resizing') {
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(7);
      expect(state.previewTime.end.getHours()).toBe(11);
      expect(state.previewTime.end.getMinutes()).toBe(7);
    }
  });

  it('resize 10:07-11:07 entry を +15px → 10:07-11:22（開始は動かさず終端だけ 15 分伸ばす）', () => {
    const resizingState: InteractionState = {
      mode: 'resizing',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: off607,
      direction: 'bottom',
      snappedHeight: 60,
      previewTime: {
        start: new Date('2026-01-15T10:07:00'),
        end: new Date('2026-01-15T11:07:00'),
      },
      isOverlapping: false,
    };
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 15 };
    const { state } = dispatch(resizingState, { type: 'POINTER_MOVE', point: movedPoint });

    if (state.mode === 'resizing') {
      expect(state.snappedHeight).toBe(75);
      expect(state.previewTime.start.getHours()).toBe(10);
      expect(state.previewTime.start.getMinutes()).toBe(7);
      expect(state.previewTime.end.getHours()).toBe(11);
      expect(state.previewTime.end.getMinutes()).toBe(22);
    }
  });
});

// ========================================
// Day-end boundary regression
// ========================================

describe('day-end boundary regression', () => {
  it('dragging a 1-hour entry to 23:00 keeps the end at next-day 00:00', () => {
    const draggingState: InteractionState = {
      mode: 'dragging',
      timeblockId: 'a',
      startPoint: origin,
      currentPoint: origin,
      originalPosition: { top: 1320, left: 0, width: 200, height: 60 },
      dateIndex: 0,
      targetDateIndex: 0,
      snappedTop: 1320,
      previewTime: {
        start: new Date('2026-01-15T22:00:00'),
        end: new Date('2026-01-15T23:00:00'),
      },
      isOverlapping: false,
    };
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 60 };
    const { state } = dispatch(draggingState, { type: 'POINTER_MOVE', point: movedPoint });

    if (state.mode === 'dragging') {
      expect(state.snappedTop).toBe(1380);
      expect(state.previewTime.start.getHours()).toBe(23);
      expect(state.previewTime.start.getMinutes()).toBe(0);
      expect(state.previewTime.end.getDate()).toBe(16);
      expect(state.previewTime.end.getHours()).toBe(0);
      expect(state.previewTime.end.getMinutes()).toBe(0);
      expect(state.previewTime.end.getTime() - state.previewTime.start.getTime()).toBe(
        60 * 60 * 1000,
      );
    }
  });

  it('RESIZE_START supports a 23:00-24:00 range instead of collapsing to one interval', () => {
    const { state } = dispatch(IDLE, {
      type: 'RESIZE_START',
      timeblockId: 'a',
      direction: 'bottom',
      point: origin,
      originalPosition: { top: 1380, left: 0, width: 200, height: 60 },
    });

    if (state.mode === 'resizing') {
      expect(state.snappedHeight).toBe(60);
      expect(state.previewTime.start.getHours()).toBe(23);
      expect(state.previewTime.end.getDate()).toBe(16);
      expect(state.previewTime.end.getHours()).toBe(0);
      expect(state.previewTime.end.getMinutes()).toBe(0);
    }
  });

  it('grid selection at 23:56 は 23:45 から始まり翌日 00:00 で終わる', () => {
    // 24:00 へ丸まる位置でも 23:00 まで巻き戻さず、当日最後のグリッドから選択する
    const { state } = dispatch(IDLE, {
      type: 'GRID_POINTER_DOWN',
      point: origin,
      dateIndex: 0,
      gridY: 1436,
    });

    if (state.mode === 'selecting') {
      expect(state.selectionRange.start.getHours()).toBe(23);
      expect(state.selectionRange.start.getMinutes()).toBe(45);
      expect(state.selectionRange.end.getDate()).toBe(16);
      expect(state.selectionRange.end.getHours()).toBe(0);
      expect(state.selectionRange.end.getMinutes()).toBe(0);
    }
  });
});

// ========================================
// Grid selection (GRID_POINTER_DOWN → POINTER_MOVE → POINTER_UP)
// ========================================
