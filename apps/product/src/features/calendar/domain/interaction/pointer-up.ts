/**
 * Interaction State Machine — POINTER_UP handler (per-mode completion)
 */

import { maxAbsDelta } from './grid-geometry';
import { DRAG_THRESHOLD_PX, IDLE } from './machine-constants';
import type { InteractionEffect, InteractionResult, InteractionState } from './types';

export function handlePointerUp(
  state: InteractionState,
  effects: InteractionEffect[],
): InteractionResult {
  switch (state.mode) {
    case 'pending': {
      effects.push({ type: 'EVENT_CLICK', timeblockId: state.timeblockId });
      return { state: IDLE, effects };
    }

    case 'longpress-pending': {
      effects.push({ type: 'CLEAR_LONGPRESS_TIMER' });
      effects.push({ type: 'EVENT_CLICK', timeblockId: state.timeblockId });
      return { state: IDLE, effects };
    }

    case 'dragging': {
      effects.push({ type: 'DRAG_STORE_END' });

      if (state.isOverlapping) {
        effects.push({ type: 'DROP_REJECTED', timeblockId: state.timeblockId, reason: 'overlap' });
        effects.push({ type: 'HAPTIC', pattern: 'error' });
      } else {
        effects.push({
          type: 'DROP',
          timeblockId: state.timeblockId,
          time: state.previewTime,
          targetDateIndex: state.targetDateIndex,
        });
      }

      return { state: IDLE, effects };
    }

    case 'resizing': {
      const hasChanged =
        Math.abs(state.snappedTop - state.originalPosition.top) > 0.01 ||
        Math.abs(state.snappedHeight - state.originalPosition.height) > 0.01;
      if (!hasChanged) return { state: IDLE, effects };

      if (state.isOverlapping) {
        effects.push({
          type: 'RESIZE_REJECTED',
          timeblockId: state.timeblockId,
          reason: 'overlap',
        });
        effects.push({ type: 'HAPTIC', pattern: 'error' });
      } else {
        effects.push({
          type: 'RESIZE_COMPLETE',
          timeblockId: state.timeblockId,
          time: state.previewTime,
        });
      }
      return { state: IDLE, effects };
    }

    case 'selecting': {
      const hasMoved = maxAbsDelta(state.startPoint, state.currentPoint) > DRAG_THRESHOLD_PX;
      if (hasMoved && !state.isOverlapping) {
        effects.push({
          type: 'SELECT_COMPLETE',
          dateIndex: state.dateIndex,
          range: state.selectionRange,
        });
      }
      return { state: IDLE, effects };
    }

    case 'selection-longpress-pending': {
      effects.push({ type: 'CLEAR_LONGPRESS_TIMER' });
      return { state: IDLE, effects };
    }

    default:
      return { state: IDLE, effects };
  }
}
