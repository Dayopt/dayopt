'use client';

/**
 * useInteraction — InteractionEffect の実行
 *
 * 状態機械（machine.ts）が返した副作用リストを DOM / store / callback に反映する。
 */

import { isPlanRecordDrop } from '@/features/timeblock';

import { useCalendarDragStore } from '../stores/useCalendarDragStore';

import type { InteractionAction, InteractionEffect } from '../domain/interaction/types';
import type { InteractionRefs, InteractionRuntime } from './interaction-runtime';

function getMinutesFromDayStart(date: Date, time: Date): number {
  const dayOffset =
    (Date.UTC(time.getFullYear(), time.getMonth(), time.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
    (24 * 60 * 60 * 1000);
  const wallClockMinutes =
    Math.round(dayOffset) * 24 * 60 + time.getHours() * 60 + time.getMinutes();
  return Math.max(0, Math.min(24 * 60, wallClockMinutes));
}

export function processInteractionEffects(
  effects: InteractionEffect[],
  r: InteractionRuntime,
  dispatchFn: (action: InteractionAction) => void,
  refs: InteractionRefs,
): void {
  const {
    stateRef,
    timerRef,
    dayColumnsRef,
    pendingTargetLaneRef,
    dragLaneRef,
    interactionVersionRef,
  } = refs;

  for (const effect of effects) {
    switch (effect.type) {
      case 'START_LONGPRESS_TIMER': {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          const s = stateRef.current;
          if (s.mode === 'longpress-pending') {
            dispatchFn({ type: 'LONGPRESS_FIRED' });
          } else if (s.mode === 'selection-longpress-pending') {
            dispatchFn({ type: 'GRID_LONGPRESS_FIRED' });
          }
        }, effect.delayMs);
        break;
      }

      case 'CLEAR_LONGPRESS_TIMER':
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        break;

      case 'HAPTIC':
        r.haptic[effect.pattern]?.();
        break;

      case 'EVENT_CLICK': {
        pendingTargetLaneRef.current = null;
        dragLaneRef.current = null;
        interactionVersionRef.current = null;
        const event = r.events.find((e) => e.id === effect.timeblockId);
        if (event) r.onEventClick?.(event);
        break;
      }

      case 'DROP': {
        const event = r.events.find((candidate) => candidate.id === effect.timeblockId);
        if (
          event?.kind === 'plan' &&
          dragLaneRef.current &&
          isPlanRecordDrop(dragLaneRef.current.source, dragLaneRef.current.target)
        ) {
          const now = Date.now();
          const planEnd = event.endDate ?? event.displayEndDate;
          const canCreateRecord = planEnd.getTime() <= now && effect.time.end.getTime() <= now;
          if (canCreateRecord) {
            r.onPlanRecord?.(effect.timeblockId, effect.time);
          }
          interactionVersionRef.current = null;
          break;
        }
        r.onEventUpdate?.(effect.timeblockId, {
          startTime: effect.time.start,
          endTime: effect.time.end,
          ...(interactionVersionRef.current
            ? { expectedUpdatedAt: interactionVersionRef.current }
            : {}),
        });
        interactionVersionRef.current = null;
        break;
      }

      case 'DROP_REJECTED':
        interactionVersionRef.current = null;
        // Snap-back animation handled by GhostRenderer
        break;

      case 'RESIZE_COMPLETE': {
        // 自動記録モデル: planned の resize は planned のみ更新（確定済み actual は固定、
        // 未編集 actual は NULL のまま）。buildTimeUpdateData が kind 別に処理するため
        // ここで actual の扱いを指定する必要はない。
        r.onEventUpdate?.(effect.timeblockId, {
          startTime: effect.time.start,
          endTime: effect.time.end,
          ...(interactionVersionRef.current
            ? { expectedUpdatedAt: interactionVersionRef.current }
            : {}),
        });
        interactionVersionRef.current = null;
        break;
      }

      case 'RESIZE_REJECTED':
        interactionVersionRef.current = null;
        // Visual feedback handled by state.isOverlapping
        break;

      case 'SELECT_COMPLETE': {
        const selDate = r.displayDates?.[effect.dateIndex] ?? r.date;
        const endMinutes = getMinutesFromDayStart(selDate, effect.range.end);
        r.onTimeRangeSelect?.({
          date: selDate,
          startHour: effect.range.start.getHours(),
          startMinute: effect.range.start.getMinutes(),
          endHour: Math.floor(endMinutes / 60),
          endMinute: endMinutes % 60,
        });
        break;
      }

      case 'DRAG_STORE_START': {
        const plan = r.events.find((e) => e.id === effect.timeblockId);
        if (plan) {
          const lane = plan.kind ?? 'plan';
          const targetLane = pendingTargetLaneRef.current ?? lane;
          dragLaneRef.current = { source: lane, target: targetLane };
          r.startDragStore(effect.timeblockId, plan, effect.dateIndex, lane);
          if (targetLane !== lane) r.updateDragStore({ targetLane });
        }
        pendingTargetLaneRef.current = null;
        // Cache day-column elements once at drag-start
        dayColumnsRef.current = document.querySelectorAll<HTMLElement>('[data-calendar-day-index]');
        break;
      }

      case 'DRAG_STORE_UPDATE':
        r.updateDragStore({
          targetDateIndex: effect.targetDateIndex,
          isDragging: true,
        });
        break;

      case 'DRAG_STORE_END': {
        const currentDrag = useCalendarDragStore.getState();
        if (currentDrag.sourceLane && currentDrag.targetLane) {
          dragLaneRef.current = {
            source: currentDrag.sourceLane,
            target: currentDrag.targetLane,
          };
        }
        r.endDragStore();
        // Clear cached day-column elements
        dayColumnsRef.current = null;
        break;
      }
    }
  }
}
