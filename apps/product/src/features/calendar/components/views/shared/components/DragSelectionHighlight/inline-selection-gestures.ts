/**
 * インラインタグパレットのポインタジェスチャ
 *
 * 選択範囲ハイライトの下端リサイズと long-press 移動を担う DOM イベントハンドラ。
 * React state には依存せず、選択時間の更新は updateSelectionTimes 経由で行う。
 */

import type React from 'react';

import {
  crossedHapticBoundary,
  MIN_TIMEBLOCK_DURATION_MINUTES,
} from '../../../../../domain/precision';
import { DRAG_CONSTANTS } from '../CalendarDragSelection/types';

interface SelectionTimesUpdate {
  startHour?: number;
  startMinute?: number;
  endHour?: number;
  endMinute?: number;
}

interface ResizeGestureOptions {
  hourHeight: number;
  startMinutes: number;
  endMinutes: number;
  updateSelectionTimes: (partial: SelectionTimesUpdate) => void;
  tap: () => void;
}

/** 下端 handle: end time だけを 1 分単位で更新するハンドラを生成する */
export function createResizeStartHandler({
  hourHeight,
  startMinutes,
  endMinutes,
  updateSelectionTimes,
  tap,
}: ResizeGestureOptions): (clientY: number) => void {
  return (clientY: number) => {
    const baseEndMin = endMinutes;
    const minEndMin = startMinutes + MIN_TIMEBLOCK_DURATION_MINUTES;
    let lastEndMin = baseEndMin;

    const onMove = (event: PointerEvent) => {
      const deltaMin = Math.round(((event.clientY - clientY) * 60) / hourHeight);
      const next = Math.max(minEndMin, Math.min(24 * 60, baseEndMin + deltaMin));
      if (next === lastEndMin) return;
      if (crossedHapticBoundary(lastEndMin, next)) tap();
      lastEndMin = next;
      updateSelectionTimes({ endHour: Math.floor(next / 60), endMinute: next % 60 });
    };

    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  };
}

interface BodyMoveGestureOptions extends ResizeGestureOptions {
  impact: () => void;
}

/** 本体 long-press: 300ms 静止で move mode に入り、duration 維持で全体を移動するハンドラを生成する */
export function createBodyPointerDownHandler({
  hourHeight,
  startMinutes,
  endMinutes,
  updateSelectionTimes,
  tap,
  impact,
}: BodyMoveGestureOptions): (e: React.PointerEvent) => void {
  return (e: React.PointerEvent) => {
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const baseStartMin = startMinutes;
    const duration = endMinutes - startMinutes;
    let phase: 'pending' | 'moving' | 'cancelled' = 'pending';
    let lastStartMin = baseStartMin;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
    };

    const onMove = (event: PointerEvent) => {
      if (phase === 'cancelled') return;
      if (phase === 'pending') {
        const dx = Math.abs(event.clientX - startClientX);
        const dy = Math.abs(event.clientY - startClientY);
        if (
          dx > DRAG_CONSTANTS.LONG_PRESS_MOVE_THRESHOLD ||
          dy > DRAG_CONSTANTS.LONG_PRESS_VERTICAL_THRESHOLD
        ) {
          phase = 'cancelled';
          cleanup();
        }
        return;
      }
      // moving
      const deltaMin = Math.round(((event.clientY - startClientY) * 60) / hourHeight);
      const next = Math.max(0, Math.min(24 * 60 - duration, baseStartMin + deltaMin));
      if (next === lastStartMin) return;
      if (crossedHapticBoundary(lastStartMin, next)) tap();
      lastStartMin = next;
      const nextEnd = next + duration;
      updateSelectionTimes({
        startHour: Math.floor(next / 60),
        startMinute: next % 60,
        endHour: Math.floor(nextEnd / 60),
        endMinute: nextEnd % 60,
      });
    };

    const onEnd = () => {
      cleanup();
    };

    timer = setTimeout(() => {
      phase = 'moving';
      impact();
    }, DRAG_CONSTANTS.LONG_PRESS_DURATION);

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  };
}
