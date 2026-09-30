'use client';

/**
 * useInteraction — グローバル DOM リスナーとカーソル管理
 *
 * インタラクション中のみ document へ move / up リスナーを張り、
 * multi-column の対象日付を解決し、ポインター操作を dispatch する。
 */

import type React from 'react';
import { useEffect } from 'react';

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
  const { stateRef, dayColumnsRef } = refs;

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
      const columns =
        dayColumnsRef.current ??
        document.querySelectorAll<HTMLElement>('[data-calendar-day-index]');
      if (r.viewMode !== 'day' && r.displayDates && r.displayDates.length > 1) {
        // Use cached NodeList during drag to avoid querySelectorAll on every pointermove
        for (const col of columns) {
          const rect = col.getBoundingClientRect();
          if (point.clientX >= rect.left && point.clientX < rect.right) {
            targetDateIndex = parseInt(col.dataset.calendarDayIndex ?? '0', 10);
            break;
          }
        }
        // Fallback: clamp to nearest edge when pointer is outside the grid columns
        if (targetDateIndex === undefined && columns.length > 0) {
          const first = columns[0]!;
          const last = columns[columns.length - 1]!;
          const edge = point.clientX < first.getBoundingClientRect().left ? first : last;
          targetDateIndex = parseInt(edge.dataset.calendarDayIndex ?? '0', 10);
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

    function handleGlobalCancel() {
      dispatch({ type: 'CANCEL' });
    }

    document.addEventListener('mousemove', handleGlobalMove, { passive: false });
    document.addEventListener('mouseup', handleGlobalUp);
    document.addEventListener('touchmove', handleGlobalMove, { passive: false });
    document.addEventListener('touchend', handleGlobalUp);
    document.addEventListener('touchcancel', handleGlobalCancel);
    document.addEventListener('pointercancel', handleGlobalCancel);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMove);
      document.removeEventListener('mouseup', handleGlobalUp);
      document.removeEventListener('touchmove', handleGlobalMove);
      document.removeEventListener('touchend', handleGlobalUp);
      document.removeEventListener('touchcancel', handleGlobalCancel);
      document.removeEventListener('pointercancel', handleGlobalCancel);
    };
  }, [mode, dispatch, latestRef, stateRef, dayColumnsRef]);
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
