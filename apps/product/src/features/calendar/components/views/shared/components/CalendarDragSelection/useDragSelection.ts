'use client';

/**
 * カレンダードラッグ選択ロジック
 *
 * 責務: 時間範囲のドラッグ選択・ダブルクリック・タッチ操作。
 * ドロップゾーン管理は CalendarDropZone に移管済み。
 *
 * 状態遷移は selection-reducer.ts、move 時の選択範囲計算は selection-move.ts
 * に分離した純粋関数を使う。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useTranslations } from 'next-intl';

import { formatTimeString } from '@/lib/date';
import { toast } from '@/lib/toast';

import { pixelsToTime as pixelsToTimeRaw } from '../../../../../domain/interaction/time-math';
import { useHapticFeedback } from '../../../../../hooks/accessibility/useHapticFeedback';
import { HOUR_HEIGHT } from '../../constants/grid.constants';

import { computeSelectionMove, resolveInstantSelection } from './selection-move';
import { IDLE, selectionReducer } from './selection-reducer';
import type { UseDragSelectionOptions, UseDragSelectionReturn } from './types';
import { DRAG_CONSTANTS } from './types';
import { useSelectionExternalEvents } from './useSelectionExternalEvents';

export function useDragSelection({
  date,
  disabled = false,
  onTimeRangeSelect,
  onDoubleClick: onDoubleClickProp,
  plans = [],
  hourHeight = HOUR_HEIGHT,
  defaultDuration,
  timeFormat,
}: UseDragSelectionOptions): UseDragSelectionReturn {
  const { tap } = useHapticFeedback();
  const t = useTranslations('timeblock');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafId = useRef<number | null>(null);
  const lastSnapRef = useRef<{ startMin: number; endMin: number } | null>(null);

  const [mode, dispatch] = useReducer(selectionReducer, IDLE);

  // Stable refs for latest props (global event handlers 用)
  const propsRef = useRef({
    date,
    disabled,
    defaultDuration,
    onTimeRangeSelect,
    onDoubleClickProp,
    hourHeight,
    tap,
    plans,
    t,
  });
  // eslint-disable-next-line react-hooks/refs -- ref mirrors: レンダー中に同期し、イベントハンドラーでのみ読み取る
  propsRef.current = {
    date,
    disabled,
    defaultDuration,
    onTimeRangeSelect,
    onDoubleClickProp,
    hourHeight,
    tap,
    plans,
    t,
  };

  const pixelsToTime = useCallback((y: number) => pixelsToTimeRaw(y, hourHeight), [hourHeight]);

  const formatTime = useCallback(
    (hour: number, minute: number): string => {
      return formatTimeString(hour, minute, timeFormat);
    },
    [timeFormat],
  );

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // ---- React event handlers ----

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || e.button !== 0) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const time = pixelsToTime(e.clientY - rect.top);
      const handler = onDoubleClickProp || onTimeRangeSelect;
      if (handler) {
        const { selection, isOverlapping } = resolveInstantSelection(
          time,
          date,
          defaultDuration,
          plans,
        );
        if (isOverlapping) {
          toast.error(t('errors.timeOverlap'));
        } else {
          handler(selection);
        }
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [pixelsToTime, disabled, onDoubleClickProp, onTimeRangeSelect, date, defaultDuration, plans, t],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (disabled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const start = pixelsToTime(y);
      dispatch({ type: 'MOUSE_DOWN', start, startPixelY: y });
      lastSnapRef.current = null;
      e.preventDefault();
      e.stopPropagation();
    },
    [pixelsToTime, disabled],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return;
      const touch = e.touches[0];
      if (!touch) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const y = touch.clientY - rect.top;
      const startTime = pixelsToTime(y);

      dispatch({
        type: 'TOUCH_START',
        startTime,
        startPixelY: y,
        startPos: { x: touch.clientX, y: touch.clientY },
      });
      lastSnapRef.current = null;

      clearTimer();
      longPressTimer.current = setTimeout(() => {
        dispatch({ type: 'LONGPRESS_FIRED', start: startTime, startPixelY: y });
        propsRef.current.tap();
      }, DRAG_CONSTANTS.LONG_PRESS_DURATION);
    },
    [pixelsToTime, disabled, clearTimer],
  );

  // ---- Global event listeners ----

  const isActive =
    mode.type === 'mouse-selecting' ||
    mode.type === 'touch-selecting' ||
    mode.type === 'touch-pending';

  useEffect(() => {
    if (!isActive) return;

    const onMouseMove = (e: MouseEvent) => {
      if (rafId.current !== null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (!containerRef.current) return;
        if (mode.type !== 'mouse-selecting') return;

        const rect = containerRef.current.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const result = computeSelectionMove({
          y,
          hourHeight: propsRef.current.hourHeight,
          start: mode.start,
          startPixelY: mode.startPixelY,
          hasDragged: mode.hasDragged,
          date: propsRef.current.date,
          plans: propsRef.current.plans,
          lastSnap: lastSnapRef.current,
        });

        if (result.snapChanged) propsRef.current.tap();
        lastSnapRef.current = result.snap;

        dispatch({
          type: 'MOUSE_MOVE',
          selection: result.selection,
          hasDragged: result.hasDragged,
          isOverlapping: result.isOverlapping,
        });
      });
    };

    const onMouseUp = () => {
      const p = propsRef.current;
      if (p.disabled) {
        dispatch({ type: 'CANCEL' });
        return;
      }
      if (mode.type === 'mouse-selecting' && mode.hasDragged) {
        if (mode.isOverlapping) {
          toast.error(p.t('errors.timeOverlap'));
        } else if (p.onTimeRangeSelect) {
          p.onTimeRangeSelect({ date: p.date, ...mode.selection, durationSource: 'dragged' });
        }
      }
      dispatch({ type: 'MOUSE_UP' });
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      // touch-pending: 長押し前に動いたらキャンセル
      // 縦方向は閾値を低くしてスクロールに素早く譲る
      if (mode.type === 'touch-pending') {
        const dx = Math.abs(touch.clientX - mode.startPos.x);
        const dy = Math.abs(touch.clientY - mode.startPos.y);
        if (
          dx > DRAG_CONSTANTS.LONG_PRESS_MOVE_THRESHOLD ||
          dy > DRAG_CONSTANTS.LONG_PRESS_VERTICAL_THRESHOLD
        ) {
          clearTimer();
          dispatch({ type: 'CANCEL' });
        }
        return;
      }

      if (mode.type !== 'touch-selecting' || !containerRef.current) return;

      // スクロール抑制（ドラッグ中のみ）
      const rect = containerRef.current.getBoundingClientRect();
      const y = touch.clientY - rect.top;
      if (Math.abs(y - mode.startPixelY) > DRAG_CONSTANTS.MIN_DRAG_DISTANCE) {
        e.preventDefault();
      }

      if (rafId.current !== null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (!containerRef.current || mode.type !== 'touch-selecting') return;

        const touchRect = containerRef.current.getBoundingClientRect();
        const touchY = touch.clientY - touchRect.top;
        const result = computeSelectionMove({
          y: touchY,
          hourHeight: propsRef.current.hourHeight,
          start: mode.start,
          startPixelY: mode.startPixelY,
          hasDragged: mode.hasDragged,
          date: propsRef.current.date,
          plans: propsRef.current.plans,
          lastSnap: lastSnapRef.current,
        });

        if (result.snapChanged) propsRef.current.tap();
        lastSnapRef.current = result.snap;

        dispatch({
          type: 'TOUCH_MOVE',
          selection: result.selection,
          hasDragged: result.hasDragged,
          isOverlapping: result.isOverlapping,
        });
      });
    };

    const onTouchEnd = (_e: TouchEvent) => {
      clearTimer();
      const p = propsRef.current;
      const handler = p.onDoubleClickProp || p.onTimeRangeSelect;

      // touch-pending: シングルタップは無視（長押しのみでTimeblock作成）
      if (mode.type === 'touch-pending') {
        dispatch({ type: 'TOUCH_END' });
        return;
      }

      if (mode.type !== 'touch-selecting') {
        dispatch({ type: 'CANCEL' });
        return;
      }
      if (p.disabled) {
        dispatch({ type: 'CANCEL' });
        return;
      }

      const sel = mode.selection;
      if (mode.hasDragged) {
        if (mode.isOverlapping) {
          toast.error(p.t('errors.timeOverlap'));
        } else if (p.onTimeRangeSelect) {
          p.onTimeRangeSelect({ date: p.date, ...sel, durationSource: 'dragged' });
        }
      } else if (handler) {
        // クライアント側overlap検出（サーバーエラーを未然に防ぐ）
        const { selection: instant, isOverlapping } = resolveInstantSelection(
          { hour: sel.startHour, minute: sel.startMinute },
          p.date,
          p.defaultDuration,
          p.plans,
        );

        if (isOverlapping) {
          toast.error(p.t('errors.timeOverlap'));
          dispatch({ type: 'CANCEL' });
          return;
        }

        handler(instant);
      }
      dispatch({ type: 'TOUCH_END' });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearTimer();
        dispatch({ type: 'CANCEL' });
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('keydown', onKeyDown);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, [isActive, mode, clearTimer]);

  // Custom events: calendar-drag-cancel / calendar-show-selection
  useSelectionExternalEvents(date, dispatch, clearTimer);

  // Derived state
  const selection =
    mode.type === 'mouse-selecting' || mode.type === 'touch-selecting'
      ? mode.selection
      : mode.type === 'show-external'
        ? mode.selection
        : null;

  const showSelectionPreview =
    (mode.type === 'mouse-selecting' && mode.hasDragged) ||
    (mode.type === 'touch-selecting' && mode.hasDragged) ||
    mode.type === 'show-external';

  const isOverlapping =
    mode.type === 'mouse-selecting' || mode.type === 'touch-selecting' ? mode.isOverlapping : false;

  return {
    isSelecting: isActive,
    selection,
    showSelectionPreview,
    isOverlapping,
    containerRef,
    handleMouseDown,
    handleDoubleClick,
    handleTouchStart,
    formatTime,
  };
}
