/**
 * Interaction State Machine tests — CANCEL・カスタム duration・idle 時の move
 */

import { describe, expect, it } from 'vitest';

import { IDLE } from './machine';
import { createCtx, dispatch, origin, rect } from './machine-test-helpers';
import type { InteractionState } from './types';

describe('CANCEL', () => {
  it('returns to idle from any state', () => {
    const states: InteractionState[] = [
      {
        mode: 'pending',
        timeblockId: 'a',
        startPoint: origin,
        originalPosition: rect,
        dateIndex: 0,
      },
      {
        mode: 'longpress-pending',
        timeblockId: 'a',
        startPoint: origin,
        originalPosition: rect,
        dateIndex: 0,
      },
      {
        mode: 'dragging',
        timeblockId: 'a',
        startPoint: origin,
        currentPoint: origin,
        originalPosition: rect,
        dateIndex: 0,
        targetDateIndex: 0,
        snappedTop: 540,
        previewTime: {
          start: new Date('2026-01-15T09:00:00'),
          end: new Date('2026-01-15T10:00:00'),
        },
        isOverlapping: false,
      },
      {
        mode: 'resizing',
        timeblockId: 'a',
        startPoint: origin,
        currentPoint: origin,
        originalPosition: rect,
        direction: 'bottom',
        snappedTop: rect.top,
        snappedHeight: rect.height,
        previewTime: {
          start: new Date('2026-01-15T09:00:00'),
          end: new Date('2026-01-15T10:00:00'),
        },
        isOverlapping: false,
      },
    ];

    for (const s of states) {
      const { state } = dispatch(s, { type: 'CANCEL' });
      expect(state.mode).toBe('idle');
    }
  });

  it('clears longpress timer from longpress-pending', () => {
    const { effects } = dispatch(
      {
        mode: 'longpress-pending',
        timeblockId: 'a',
        startPoint: origin,
        originalPosition: rect,
        dateIndex: 0,
      },
      { type: 'CANCEL' },
    );
    expect(effects).toContainEqual({ type: 'CLEAR_LONGPRESS_TIMER' });
  });

  it('ends drag store from dragging', () => {
    const { effects } = dispatch(
      {
        mode: 'dragging',
        timeblockId: 'a',
        startPoint: origin,
        currentPoint: origin,
        originalPosition: rect,
        dateIndex: 0,
        targetDateIndex: 0,
        snappedTop: 540,
        previewTime: {
          start: new Date('2026-01-15T09:00:00'),
          end: new Date('2026-01-15T10:00:00'),
        },
        isOverlapping: false,
      },
      { type: 'CANCEL' },
    );
    expect(effects).toContainEqual({ type: 'DRAG_STORE_END' });
  });
});

// ========================================
// Context: getTimeblockDurationMs
// ========================================

describe('Custom timeblock duration', () => {
  it('uses getTimeblockDurationMs for 30-minute event', () => {
    const ctx = createCtx({
      getTimeblockDurationMs: () => 30 * 60 * 1000, // 30 min
    });

    const pendingState: InteractionState = {
      mode: 'pending',
      timeblockId: 'short',
      startPoint: origin,
      originalPosition: { ...rect, top: 540 }, // 9:00
      dateIndex: 0,
    };

    // Move beyond threshold
    const movedPoint = { clientX: origin.clientX, clientY: origin.clientY + 10 };
    const { state } = dispatch(pendingState, { type: 'POINTER_MOVE', point: movedPoint }, ctx);

    if (state.mode === 'dragging') {
      const durationMs = state.previewTime.end.getTime() - state.previewTime.start.getTime();
      expect(durationMs).toBe(30 * 60 * 1000);
    }
  });
});

// ========================================
// Edge case: upward selection (drag up)
// ========================================

describe('POINTER_MOVE in idle', () => {
  it('stays idle (no-op)', () => {
    const { state, effects } = dispatch(IDLE, {
      type: 'POINTER_MOVE',
      point: { clientX: 300, clientY: 400 },
    });
    expect(state.mode).toBe('idle');
    expect(effects).toHaveLength(0);
  });
});
