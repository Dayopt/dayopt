/**
 * Interaction State Machine tests — ドラッグ開始（pending / longpress / クリック判定）
 */

import { describe, expect, it } from 'vitest';

import { DRAG_THRESHOLD_PX, IDLE, LONGPRESS_DELAY_MS, TOUCH_SCROLL_THRESHOLD_PX } from './machine';
import { createCtx, dispatch, origin, rect } from './machine-test-helpers';
import type { InteractionState } from './types';

// ========================================
// idle → pending (POINTER_DOWN)
// ========================================

describe('POINTER_DOWN', () => {
  it('idle → pending', () => {
    const { state, effects } = dispatch(IDLE, {
      type: 'POINTER_DOWN',
      timeblockId: 'a',
      point: origin,
      originalPosition: rect,
      dateIndex: 0,
    });

    expect(state.mode).toBe('pending');
    if (state.mode === 'pending') {
      expect(state.timeblockId).toBe('a');
      expect(state.startPoint).toEqual(origin);
      expect(state.originalPosition).toEqual(rect);
      expect(state.dateIndex).toBe(0);
    }
    expect(effects).toHaveLength(0);
  });

  it('ignores POINTER_DOWN when not idle', () => {
    const pendingState: InteractionState = {
      mode: 'pending',
      timeblockId: 'a',
      startPoint: origin,
      originalPosition: rect,
      dateIndex: 0,
    };
    const { state } = dispatch(pendingState, {
      type: 'POINTER_DOWN',
      timeblockId: 'b',
      point: { clientX: 0, clientY: 0 },
      originalPosition: rect,
      dateIndex: 0,
    });
    expect(state.mode).toBe('pending');
    if (state.mode === 'pending') {
      expect(state.timeblockId).toBe('a'); // unchanged
    }
  });
});

// ========================================
// idle → longpress-pending (TOUCH_START)
// ========================================

describe('TOUCH_START', () => {
  it('idle → longpress-pending with timer effect', () => {
    const { state, effects } = dispatch(IDLE, {
      type: 'TOUCH_START',
      timeblockId: 'a',
      point: origin,
      originalPosition: rect,
      dateIndex: 0,
    });

    expect(state.mode).toBe('longpress-pending');
    expect(effects).toContainEqual({
      type: 'START_LONGPRESS_TIMER',
      delayMs: LONGPRESS_DELAY_MS,
    });
  });
});

// ========================================
// longpress-pending → dragging (LONGPRESS_FIRED)
// ========================================

describe('LONGPRESS_FIRED', () => {
  const longpressState: InteractionState = {
    mode: 'longpress-pending',
    timeblockId: 'a',
    startPoint: origin,
    originalPosition: rect,
    dateIndex: 0,
  };

  it('transitions to dragging with haptic and drag store effects', () => {
    const { state, effects } = dispatch(longpressState, { type: 'LONGPRESS_FIRED' });

    expect(state.mode).toBe('dragging');
    if (state.mode === 'dragging') {
      expect(state.timeblockId).toBe('a');
      expect(state.targetDateIndex).toBe(0);
      expect(state.isOverlapping).toBe(false);
      // snappedTop should match original position (540 = 9:00)
      expect(state.snappedTop).toBe(540);
      expect(state.previewTime.start.getHours()).toBe(9);
    }

    expect(effects).toContainEqual({ type: 'HAPTIC', pattern: 'impact' });
    expect(effects).toContainEqual({
      type: 'DRAG_STORE_START',
      timeblockId: 'a',
      dateIndex: 0,
    });
  });

  it('computes overlap for the snapped long-press preview before any pointer move', () => {
    const { state } = dispatch(
      {
        mode: 'longpress-pending',
        timeblockId: 'a',
        startPoint: origin,
        originalPosition: { top: 607, left: 0, width: 200, height: 60 },
        dateIndex: 0,
      },
      { type: 'LONGPRESS_FIRED' },
      createCtx({
        checkOverlap: (_timeblockId, start, end) =>
          start.getHours() === 10 && start.getMinutes() === 7 && end.getHours() === 11,
      }),
    );

    if (state.mode === 'dragging') {
      // 相対 snap なので移動量ゼロの長押し直後は 10:07 をそのまま保持する
      expect(state.previewTime.start.getMinutes()).toBe(7);
      expect(state.isOverlapping).toBe(true);
    }
  });

  it('ignores when not in longpress-pending mode', () => {
    const { state } = dispatch(IDLE, { type: 'LONGPRESS_FIRED' });
    expect(state.mode).toBe('idle');
  });
});

// ========================================
// pending → dragging (POINTER_MOVE > threshold)
// ========================================

describe('POINTER_MOVE from pending', () => {
  const pendingState: InteractionState = {
    mode: 'pending',
    timeblockId: 'a',
    startPoint: origin,
    originalPosition: rect,
    dateIndex: 0,
  };

  it('stays pending when movement is below threshold', () => {
    const { state } = dispatch(pendingState, {
      type: 'POINTER_MOVE',
      point: { clientX: origin.clientX + 2, clientY: origin.clientY + 3 },
    });
    expect(state.mode).toBe('pending');
  });

  it('transitions to dragging when movement exceeds threshold', () => {
    const movedPoint = {
      clientX: origin.clientX,
      clientY: origin.clientY + DRAG_THRESHOLD_PX + 1,
    };
    const { state, effects } = dispatch(pendingState, {
      type: 'POINTER_MOVE',
      point: movedPoint,
    });

    expect(state.mode).toBe('dragging');
    if (state.mode === 'dragging') {
      expect(state.timeblockId).toBe('a');
      expect(state.currentPoint).toEqual(movedPoint);
      expect(state.previewTime.start).toBeInstanceOf(Date);
    }
    expect(effects).toContainEqual(expect.objectContaining({ type: 'DRAG_STORE_START' }));
  });

  it('computes overlap when transitioning to dragging', () => {
    const ctx = createCtx({ checkOverlap: () => true });
    const movedPoint = {
      clientX: origin.clientX,
      clientY: origin.clientY + 20,
    };
    const { state } = dispatch(pendingState, { type: 'POINTER_MOVE', point: movedPoint }, ctx);

    expect(state.mode).toBe('dragging');
    if (state.mode === 'dragging') {
      expect(state.isOverlapping).toBe(true);
    }
  });
});

// ========================================
// pending → idle (click via POINTER_UP)
// ========================================

describe('POINTER_UP from pending (click)', () => {
  it('returns to idle with EVENT_CLICK effect', () => {
    const pendingState: InteractionState = {
      mode: 'pending',
      timeblockId: 'a',
      startPoint: origin,
      originalPosition: rect,
      dateIndex: 0,
    };
    const { state, effects } = dispatch(pendingState, { type: 'POINTER_UP' });

    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual({ type: 'EVENT_CLICK', timeblockId: 'a' });
  });
});

// ========================================
// longpress-pending → idle (scroll cancel)
// ========================================

describe('POINTER_MOVE from longpress-pending', () => {
  const longpressState: InteractionState = {
    mode: 'longpress-pending',
    timeblockId: 'a',
    startPoint: origin,
    originalPosition: rect,
    dateIndex: 0,
  };

  it('cancels long-press when finger moves beyond scroll threshold', () => {
    const movedPoint = {
      clientX: origin.clientX,
      clientY: origin.clientY + TOUCH_SCROLL_THRESHOLD_PX + 1,
    };
    const { state, effects } = dispatch(longpressState, {
      type: 'POINTER_MOVE',
      point: movedPoint,
    });

    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual({ type: 'CLEAR_LONGPRESS_TIMER' });
  });

  it('stays in longpress-pending when movement is small', () => {
    const movedPoint = {
      clientX: origin.clientX + 3,
      clientY: origin.clientY + 3,
    };
    const { state } = dispatch(longpressState, {
      type: 'POINTER_MOVE',
      point: movedPoint,
    });
    expect(state.mode).toBe('longpress-pending');
  });
});

// ========================================
// longpress-pending → idle (touch release before 500ms)
// ========================================

describe('POINTER_UP from longpress-pending (quick tap → click)', () => {
  it('fires EVENT_CLICK and clears timer', () => {
    const longpressState: InteractionState = {
      mode: 'longpress-pending',
      timeblockId: 'a',
      startPoint: origin,
      originalPosition: rect,
      dateIndex: 0,
    };
    const { state, effects } = dispatch(longpressState, { type: 'POINTER_UP' });

    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual({ type: 'CLEAR_LONGPRESS_TIMER' });
    expect(effects).toContainEqual({ type: 'EVENT_CLICK', timeblockId: 'a' });
  });
});

// ========================================
// dragging → dragging (POINTER_MOVE update)
// ========================================
