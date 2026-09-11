/**
 * Interaction State Machine tests — グリッド選択（mouse / touch / 上方向）
 */

import { describe, expect, it } from 'vitest';

import { IDLE, SELECTION_LONGPRESS_DELAY_MS, TOUCH_SCROLL_THRESHOLD_PX } from './machine';
import { dispatch } from './machine-test-helpers';
import type { InteractionState } from './types';

describe('Grid selection (mouse)', () => {
  it('GRID_POINTER_DOWN → selecting with initial minimum-duration range', () => {
    const { state } = dispatch(IDLE, {
      type: 'GRID_POINTER_DOWN',
      point: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridY: 540, // 9:00
    });

    expect(state.mode).toBe('selecting');
    if (state.mode === 'selecting') {
      expect(state.dateIndex).toBe(0);
      expect(state.gridStartY).toBe(540);
      expect(state.selectionRange.start.getHours()).toBe(9);
      expect(state.selectionRange.start.getMinutes()).toBe(0);
      // 初期選択は 1 snap 分（15 分）
      expect(state.selectionRange.end.getHours()).toBe(9);
      expect(state.selectionRange.end.getMinutes()).toBe(15);
    }
  });

  it('POINTER_MOVE extends selection range', () => {
    const selectingState: InteractionState = {
      mode: 'selecting',
      startPoint: { clientX: 100, clientY: 300 },
      currentPoint: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridStartY: 540, // 9:00
      selectionRange: {
        start: new Date('2026-01-15T09:00:00'),
        end: new Date('2026-01-15T09:15:00'),
      },
      isOverlapping: false,
    };

    // Move 60px down = 1 hour
    const { state } = dispatch(selectingState, {
      type: 'POINTER_MOVE',
      point: { clientX: 100, clientY: 360 },
    });

    if (state.mode === 'selecting') {
      expect(state.selectionRange.start.getHours()).toBe(9);
      expect(state.selectionRange.end.getHours()).toBe(10);
    }
  });

  it('POINTER_UP with movement → SELECT_COMPLETE', () => {
    const selectingState: InteractionState = {
      mode: 'selecting',
      startPoint: { clientX: 100, clientY: 300 },
      currentPoint: { clientX: 100, clientY: 380 }, // moved > 5px
      dateIndex: 0,
      gridStartY: 540,
      selectionRange: {
        start: new Date('2026-01-15T09:00:00'),
        end: new Date('2026-01-15T10:00:00'),
      },
      isOverlapping: false,
    };

    const { state, effects } = dispatch(selectingState, { type: 'POINTER_UP' });

    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual(
      expect.objectContaining({ type: 'SELECT_COMPLETE', dateIndex: 0 }),
    );
  });

  it('POINTER_UP without movement → no selection', () => {
    const selectingState: InteractionState = {
      mode: 'selecting',
      startPoint: { clientX: 100, clientY: 300 },
      currentPoint: { clientX: 100, clientY: 302 }, // moved < 5px
      dateIndex: 0,
      gridStartY: 540,
      selectionRange: {
        start: new Date('2026-01-15T09:00:00'),
        end: new Date('2026-01-15T09:15:00'),
      },
      isOverlapping: false,
    };

    const { state, effects } = dispatch(selectingState, { type: 'POINTER_UP' });

    expect(state.mode).toBe('idle');
    expect(effects).not.toContainEqual(expect.objectContaining({ type: 'SELECT_COMPLETE' }));
  });
});

// ========================================
// Grid selection (touch — long-press required)
// ========================================

describe('Grid selection (touch)', () => {
  it('GRID_TOUCH_START → selection-longpress-pending with timer', () => {
    const { state, effects } = dispatch(IDLE, {
      type: 'GRID_TOUCH_START',
      point: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridY: 540,
    });

    expect(state.mode).toBe('selection-longpress-pending');
    expect(effects).toContainEqual({
      type: 'START_LONGPRESS_TIMER',
      delayMs: SELECTION_LONGPRESS_DELAY_MS,
    });
  });

  it('GRID_LONGPRESS_FIRED → selecting with haptic', () => {
    const pending: InteractionState = {
      mode: 'selection-longpress-pending',
      startPoint: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridStartY: 540,
    };

    const { state, effects } = dispatch(pending, { type: 'GRID_LONGPRESS_FIRED' });

    expect(state.mode).toBe('selecting');
    expect(effects).toContainEqual({ type: 'HAPTIC', pattern: 'tap' });
  });

  it('POINTER_MOVE > threshold cancels selection-longpress-pending', () => {
    const pending: InteractionState = {
      mode: 'selection-longpress-pending',
      startPoint: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridStartY: 540,
    };

    const { state, effects } = dispatch(pending, {
      type: 'POINTER_MOVE',
      point: { clientX: 100, clientY: 300 + TOUCH_SCROLL_THRESHOLD_PX + 1 },
    });

    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual({ type: 'CLEAR_LONGPRESS_TIMER' });
  });

  it('POINTER_UP from selection-longpress-pending clears timer', () => {
    const pending: InteractionState = {
      mode: 'selection-longpress-pending',
      startPoint: { clientX: 100, clientY: 300 },
      dateIndex: 0,
      gridStartY: 540,
    };

    const { state, effects } = dispatch(pending, { type: 'POINTER_UP' });
    expect(state.mode).toBe('idle');
    expect(effects).toContainEqual({ type: 'CLEAR_LONGPRESS_TIMER' });
  });
});

// ========================================
// CANCEL
// ========================================

describe('Upward selection', () => {
  it('ignores upward drag and keeps start time fixed', () => {
    const selectingState: InteractionState = {
      mode: 'selecting',
      startPoint: { clientX: 100, clientY: 400 },
      currentPoint: { clientX: 100, clientY: 400 },
      dateIndex: 0,
      gridStartY: 600, // 10:00
      selectionRange: {
        start: new Date('2026-01-15T10:00:00'),
        end: new Date('2026-01-15T10:15:00'),
      },
      isOverlapping: false,
    };

    // Move up 60px (1 hour) — downward-only なので開始時刻は固定
    const { state } = dispatch(selectingState, {
      type: 'POINTER_MOVE',
      point: { clientX: 100, clientY: 340 },
    });

    if (state.mode === 'selecting') {
      // 上方向ドラッグは無視: 10:00 → 10:05（最小ブロック長）
      expect(state.selectionRange.start.getHours()).toBe(10);
      expect(state.selectionRange.start.getMinutes()).toBe(0);
      expect(state.selectionRange.end.getHours()).toBe(10);
      expect(state.selectionRange.end.getMinutes()).toBe(15);
    }
  });
});

// ========================================
// POINTER_MOVE in idle (no-op)
// ========================================
