'use client';

/**
 * useInteraction — グローバル DOM リスナーとカーソル管理
 *
 * インタラクション中のみ document へ move / up リスナーを張り、
 * multi-column の対象日付・2レーンの target lane を解決して dispatch する。
 */

import type React from 'react';
import { useEffect } from 'react';

import { resolveTimeblockDestination } from '@/features/timeblock';

import { hasLaneCounterpart, resolveTwoLaneFromPointer } from '../lib/two-lane-layout';

import {
  constrainToRect,
  getPointerPoint,
  isTouchEvent,
} from '../domain/interaction/pointer-tracker';
import type { InteractionAction, InteractionState } from '../domain/interaction/types';
import type { InteractionRefs, InteractionRuntime } from './interaction-runtime';

interface UseInteractionListenersOptions {
  mode: InteractionState['mode'];
  dispatch: (action: InteractionAction) => void;
  latestRef: React.MutableRefObject<InteractionRuntime>;
  refs: InteractionRefs;
}

/** インタラクション中のグローバル move / up リスナー */
export function useInteractionListeners({
  mode,
  dispatch,
  latestRef,
  refs,
}: UseInteractionListenersOptions): void {
  const { stateRef, dayColumnsRef, pendingTargetLaneRef, dragLaneRef } = refs;

  useEffect(() => {
    const needsListeners =
      mode === 'pending' ||
      mode === 'longpress-pending' ||
      mode === 'dragging' ||
      mode === 'resizing' ||
      mode === 'selecting' ||
      mode === 'selection-longpress-pending';

    if (!needsListeners) return;

    function handleGlobalMove(e: MouseEvent | TouchEvent) {
      const raw = getPointerPoint(e);

      // Constrain to calendar container bounds
      const container =
        document.querySelector<HTMLElement>('[data-calendar-main]') ??
        document.querySelector<HTMLElement>('main');
      const point = container ? constrainToRect(raw, container.getBoundingClientRect()) : raw;

      // Calculate target date index for multi-column views
      let targetDateIndex: number | undefined;
      const r = latestRef.current;
      let targetColumn: HTMLElement | undefined;
      const columns =
        dayColumnsRef.current ??
        document.querySelectorAll<HTMLElement>('[data-calendar-day-index]');
      if (r.viewMode !== 'day' && r.displayDates && r.displayDates.length > 1) {
        // Use cached NodeList during drag to avoid querySelectorAll on every pointermove
        for (const col of columns) {
          const rect = col.getBoundingClientRect();
          if (point.clientX >= rect.left && point.clientX < rect.right) {
            targetColumn = col;
            targetDateIndex = parseInt(col.dataset.calendarDayIndex ?? '0', 10);
            break;
          }
        }
        // Fallback: clamp to nearest edge when pointer is outside the grid columns
        if (targetDateIndex === undefined && columns.length > 0) {
          const first = columns[0]!;
          const last = columns[columns.length - 1]!;
          const edge = point.clientX < first.getBoundingClientRect().left ? first : last;
          targetColumn = edge;
          targetDateIndex = parseInt(edge.dataset.calendarDayIndex ?? '0', 10);
        }
      }

      if (!targetColumn) {
        targetColumn = Array.from(columns).find((column) => {
          const rect = column.getBoundingClientRect();
          return point.clientX >= rect.left && point.clientX < rect.right;
        });
      }
      const dragState = stateRef.current;
      const interactionMode = dragState.mode;
      if ((dragState.mode === 'pending' || dragState.mode === 'dragging') && targetColumn) {
        const rect = targetColumn.getBoundingClientRect();

        // #2250: 相手レーンに timeblock が無い時刻（= 画面上フル幅で境界が見えない）では、
        // x 座標に関わらず sourceLane を維持する。表示だけフル幅にして pointer 判定を
        // 旧固定境界のまま残すと、境界の見えないカラムで意図しない Plan→Record 変換が
        // 発火する（plan-review で検出した P1 故障モード）。
        const draggedTimeblock = r.events.find((event) => event.id === dragState.timeblockId);
        const sourceLane: 'plan' | 'record' =
          draggedTimeblock?.kind ??
          (draggedTimeblock
            ? resolveTimeblockDestination(
                draggedTimeblock.endDate ?? draggedTimeblock.displayEndDate,
              )
            : 'plan');
        // dragging は直近 tick の previewTime（1 frame 遅れ、体感上は無視できる）、
        // pending はまだ previewTime が無いので timeblock 自身の現在時刻で近似する。
        const timeblockStart =
          draggedTimeblock?.displayStartDate ?? draggedTimeblock?.startDate ?? null;
        const timeblockEnd = draggedTimeblock?.displayEndDate ?? draggedTimeblock?.endDate ?? null;
        const targetTime =
          dragState.mode === 'dragging'
            ? dragState.previewTime
            : timeblockStart && timeblockEnd
              ? { start: timeblockStart, end: timeblockEnd }
              : null;
        const counterpartKind = sourceLane === 'plan' ? 'record' : 'plan';
        const hasCounterpart = targetTime
          ? hasLaneCounterpart(
              r.allEvents.flatMap((event) => {
                const kind =
                  event.kind ?? resolveTimeblockDestination(event.endDate ?? event.displayEndDate);
                if (kind !== counterpartKind) return [];
                const start = event.displayStartDate ?? event.startDate;
                const end = event.displayEndDate ?? event.endDate;
                // display*/startDate/endDate が両方欠けた timeblock は判定できないため除外する
                // （hasLaneCounterpart 自体は非 null Date を要求する契約を維持する）。
                if (!start || !end) return [];
                return [{ displayStartDate: start, displayEndDate: end }];
              }),
              targetTime.start,
              targetTime.end,
            )
          : true; // timeblock 不明時は安全側（変換を許容する既存挙動）に倒す

        const targetLane = resolveTwoLaneFromPointer(
          point.clientX,
          rect.left,
          rect.width,
          r.planLaneWidthPercent,
          { sourceLane, hasCounterpart },
        );
        if (interactionMode === 'pending') {
          pendingTargetLaneRef.current = targetLane;
        } else {
          if (dragLaneRef.current) dragLaneRef.current.target = targetLane;
          r.updateDragStore({ targetLane });
        }
      }

      // Prevent scroll during active drag/resize/select
      if (isTouchEvent(e)) {
        const s = stateRef.current;
        if (s.mode === 'dragging' || s.mode === 'resizing' || s.mode === 'selecting') {
          e.preventDefault();
        }
      }

      dispatch({
        type: 'POINTER_MOVE',
        point,
        ...(targetDateIndex !== undefined ? { targetDateIndex } : {}),
      });
    }

    function handleGlobalUp() {
      dispatch({ type: 'POINTER_UP' });
    }

    document.addEventListener('mousemove', handleGlobalMove, { passive: false });
    document.addEventListener('mouseup', handleGlobalUp);
    document.addEventListener('touchmove', handleGlobalMove, { passive: false });
    document.addEventListener('touchend', handleGlobalUp);
    document.addEventListener('touchcancel', handleGlobalUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMove);
      document.removeEventListener('mouseup', handleGlobalUp);
      document.removeEventListener('touchmove', handleGlobalMove);
      document.removeEventListener('touchend', handleGlobalUp);
      document.removeEventListener('touchcancel', handleGlobalUp);
    };
  }, [mode, dispatch, latestRef, stateRef, dayColumnsRef, pendingTargetLaneRef, dragLaneRef]);
}

/** ドラッグ / リサイズ中のグローバルカーソル管理 */
export function useInteractionCursor(mode: InteractionState['mode']): void {
  useEffect(() => {
    if (mode !== 'dragging' && mode !== 'resizing') return;

    const cursor = mode === 'resizing' ? 'ns-resize' : 'grabbing';
    document.body.style.setProperty('cursor', cursor, 'important');
    document.body.style.setProperty('user-select', 'none', 'important');
    document.documentElement.style.setProperty('cursor', cursor, 'important');

    const style = document.createElement('style');
    style.id = 'interaction-cursor-override';
    style.textContent = `* { cursor: ${cursor} !important; }`;
    document.head.appendChild(style);

    return () => {
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      document.documentElement.style.removeProperty('cursor');
      const el = document.getElementById('interaction-cursor-override');
      if (el) el.remove();
    };
  }, [mode]);
}
