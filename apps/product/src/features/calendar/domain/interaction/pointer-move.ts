/**
 * Interaction State Machine — POINTER_MOVE handler (per-mode routing)
 *
 * 既存ブロックの移動・リサイズは相対 snap（`../precision` 参照）。移動量だけを
 * snap interval で量子化し、元ブロックの分と duration を保持する。リサイズは
 * 終端だけを動かし、開始時刻には触れない。
 */

import { crossedHapticBoundary } from '../precision';
import {
  buildMoveTimeRange,
  buildSelectionRange,
  maxAbsDelta,
  minutesToDate,
  resizeHeightPx,
  resolveMoveStartMinutes,
  resolveResizeEndMinutes,
  resolveResizeOriginalEndMinutes,
  resolveResizeStartMinutes,
  resolveResizeTopMinutes,
  resolveTargetDate,
} from './grid-geometry';
import { DRAG_THRESHOLD_PX, IDLE, TOUCH_SCROLL_THRESHOLD_PX } from './machine-constants';
import { minutesToPixels, snapDeltaMinutes } from './time-math';
import type {
  InteractionContext,
  InteractionEffect,
  InteractionResult,
  InteractionState,
  Point,
  TimeRange,
} from './types';

/** 移動後の開始位置（分 / px）と preview を相対 snap でまとめて求める。 */
function computeMovePreview(
  ctx: InteractionContext,
  timeblockId: string,
  originalTopPx: number,
  deltaPx: number,
  targetDateIndex: number,
  interval: number,
): { startMinutes: number; snappedTop: number; previewTime: TimeRange } {
  const durationMinutes = Math.round(ctx.getTimeblockDurationMs(timeblockId) / 60_000);
  const startMinutes = resolveMoveStartMinutes({
    originalTopPx,
    deltaPx,
    hourHeight: ctx.hourHeight,
    intervalMin: interval,
    durationMinutes,
  });
  const targetDate = resolveTargetDate(ctx, targetDateIndex);

  return {
    startMinutes,
    snappedTop: minutesToPixels(startMinutes, ctx.hourHeight),
    previewTime: buildMoveTimeRange(targetDate, startMinutes, durationMinutes),
  };
}

export function handlePointerMove(
  state: InteractionState,
  action: { type: 'POINTER_MOVE'; point: Point; targetDateIndex?: number },
  ctx: InteractionContext,
  effects: InteractionEffect[],
  interval: number,
): InteractionResult {
  switch (state.mode) {
    case 'pending': {
      if (maxAbsDelta(state.startPoint, action.point) <= DRAG_THRESHOLD_PX) {
        return { state, effects };
      }
      // Threshold crossed → transition to dragging
      const targetDateIndex = action.targetDateIndex ?? state.dateIndex;
      const { snappedTop, previewTime } = computeMovePreview(
        ctx,
        state.timeblockId,
        state.originalPosition.top,
        action.point.clientY - state.startPoint.clientY,
        targetDateIndex,
        interval,
      );
      const isOverlapping = ctx.checkOverlap(
        state.timeblockId,
        previewTime.start,
        previewTime.end,
        'drag',
      );

      effects.push({
        type: 'DRAG_STORE_START',
        timeblockId: state.timeblockId,
        dateIndex: state.dateIndex,
      });

      return {
        state: {
          mode: 'dragging',
          timeblockId: state.timeblockId,
          startPoint: state.startPoint,
          currentPoint: action.point,
          originalPosition: state.originalPosition,
          dateIndex: state.dateIndex,
          targetDateIndex,
          snappedTop,
          previewTime,
          isOverlapping,
        },
        effects,
      };
    }

    case 'longpress-pending': {
      if (maxAbsDelta(state.startPoint, action.point) > TOUCH_SCROLL_THRESHOLD_PX) {
        effects.push({ type: 'CLEAR_LONGPRESS_TIMER' });
        return { state: IDLE, effects };
      }
      return { state, effects };
    }

    case 'dragging': {
      const targetDateIndex = action.targetDateIndex ?? state.targetDateIndex;
      const { startMinutes, snappedTop, previewTime } = computeMovePreview(
        ctx,
        state.timeblockId,
        state.originalPosition.top,
        action.point.clientY - state.startPoint.clientY,
        targetDateIndex,
        interval,
      );
      const isOverlapping = ctx.checkOverlap(
        state.timeblockId,
        previewTime.start,
        previewTime.end,
        'drag',
      );

      const prevStartMinutes = Math.round((state.snappedTop / ctx.hourHeight) * 60);
      if (crossedHapticBoundary(prevStartMinutes, startMinutes)) {
        effects.push({ type: 'HAPTIC', pattern: 'tap' });
      }
      effects.push({ type: 'DRAG_STORE_UPDATE', targetDateIndex });

      return {
        state: {
          ...state,
          currentPoint: action.point,
          targetDateIndex,
          snappedTop,
          previewTime,
          isOverlapping,
        },
        effects,
      };
    }

    case 'resizing': {
      const deltaY = action.point.clientY - state.startPoint.clientY;
      // snap 粒度に達していない動きでは短いブロックや既存値を正規化しない。
      if (snapDeltaMinutes(deltaY, ctx.hourHeight, interval) === 0) return { state, effects };

      const originalStartMinutes = resolveResizeStartMinutes(
        state.originalPosition.top,
        ctx.hourHeight,
      );
      const originalEndMinutes = resolveResizeOriginalEndMinutes(
        state.originalPosition.top + state.originalPosition.height,
        ctx.hourHeight,
      );
      const startMinutes =
        state.direction === 'top'
          ? resolveResizeTopMinutes({
              originalTopPx: state.originalPosition.top,
              originalBottomPx: state.originalPosition.top + state.originalPosition.height,
              deltaPx: deltaY,
              hourHeight: ctx.hourHeight,
              intervalMin: interval,
            })
          : originalStartMinutes;
      const endMinutes =
        state.direction === 'top'
          ? originalEndMinutes
          : resolveResizeEndMinutes({
              startMinutes,
              originalEndPx: state.originalPosition.top + state.originalPosition.height,
              deltaPx: deltaY,
              hourHeight: ctx.hourHeight,
              intervalMin: interval,
              minEndMinutes: ctx.getResizeMinEndMinutes?.(state.timeblockId) ?? null,
            });
      const snappedTop = minutesToPixels(startMinutes, ctx.hourHeight);
      const newHeight = resizeHeightPx(startMinutes, endMinutes, ctx.hourHeight);

      const previousEdgeMinutes =
        state.direction === 'top'
          ? Math.round((state.snappedTop / ctx.hourHeight) * 60)
          : originalStartMinutes + Math.round((state.snappedHeight / ctx.hourHeight) * 60);
      const nextEdgeMinutes = state.direction === 'top' ? startMinutes : endMinutes;
      if (crossedHapticBoundary(previousEdgeMinutes, nextEdgeMinutes)) {
        effects.push({ type: 'HAPTIC', pattern: 'tap' });
      }

      const start = minutesToDate(ctx.date, startMinutes);
      const end = minutesToDate(ctx.date, endMinutes);

      const previewTime: TimeRange = { start, end };
      const isOverlapping = ctx.checkOverlap(state.timeblockId, start, end, 'resize');

      return {
        state: {
          ...state,
          currentPoint: action.point,
          snappedTop,
          snappedHeight: newHeight,
          previewTime,
          isOverlapping,
        },
        effects,
      };
    }

    case 'selecting': {
      const deltaY = action.point.clientY - state.startPoint.clientY;
      const currentGridY = state.gridStartY + deltaY;
      const targetDate = resolveTargetDate(ctx, state.dateIndex);
      const selectionRange = buildSelectionRange(
        state.gridStartY,
        currentGridY,
        ctx.hourHeight,
        targetDate,
        interval,
      );

      return {
        state: {
          ...state,
          currentPoint: action.point,
          selectionRange,
        },
        effects,
      };
    }

    case 'selection-longpress-pending': {
      if (maxAbsDelta(state.startPoint, action.point) > TOUCH_SCROLL_THRESHOLD_PX) {
        effects.push({ type: 'CLEAR_LONGPRESS_TIMER' });
        return { state: IDLE, effects };
      }
      return { state, effects };
    }

    default:
      return { state, effects };
  }
}
