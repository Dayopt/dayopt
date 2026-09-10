'use client';

/**
 * useInteraction — 統合インタラクションhook
 *
 * 純粋状態機械（machine.ts）をReactに接続する唯一のhook。
 * 実装は責務ごとに分割している:
 * - 入出力型・runtime 参照バンドル: interaction-runtime.ts
 * - InteractionEffect の実行: interaction-effects.ts
 * - グローバルリスナー・カーソル管理: useInteractionListeners.ts
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useHapticFeedback } from '../hooks/accessibility/useHapticFeedback';

import { isPlanRecordDrop } from '@/features/timeblock';
import { checkClientSideOverlapByKind } from '../lib/overlap';
import { hasCalendarActualRangeDiff } from '../lib/timeblock-time';
import { DEFAULT_PLAN_LANE_WIDTH_PERCENT } from '../lib/two-lane-layout';
import { useCalendarDragStore } from '../stores/useCalendarDragStore';

import { IDLE, interactionReducer } from '../domain/interaction/machine';
import { getPointerPoint } from '../domain/interaction/pointer-tracker';
import type {
  InteractionAction,
  InteractionContext,
  InteractionState,
  TimeblockRect,
} from '../domain/interaction/types';
import { processInteractionEffects } from './interaction-effects';
import type {
  InteractionRefs,
  InteractionRuntime,
  UseInteractionProps,
  UseInteractionReturn,
} from './interaction-runtime';
import { useInteractionCursor, useInteractionListeners } from './useInteractionListeners';

export type { UseInteractionProps } from './interaction-runtime';

/** 純粋状態機械をReactに接続する統合インタラクションフック */
export function useInteraction(props: UseInteractionProps): UseInteractionReturn {
  const haptic = useHapticFeedback();

  // Drag store actions
  const startDragStore = useCalendarDragStore((s) => s.startDrag);
  const updateDragStore = useCalendarDragStore((s) => s.updateDrag);
  const endDragStore = useCalendarDragStore((s) => s.endDrag);

  // State: ref for authoritative value (avoids stale closures), useState for renders
  const stateRef = useRef<InteractionState>(IDLE);
  const [renderState, setRenderState] = useState<InteractionState>(IDLE);

  // Ref for all mutable dependencies — updated every render, read by stable dispatch
  const latestRef = useRef<InteractionRuntime>({
    events: props.events,
    allEvents: props.allEventsForOverlapCheck ?? props.events,
    hourHeight: props.hourHeight,
    planLaneWidthPercent: props.planLaneWidthPercent ?? DEFAULT_PLAN_LANE_WIDTH_PERCENT,
    date: props.date,
    displayDates: props.displayDates,
    viewMode: props.viewMode ?? 'day',
    disabledPlanId: props.disabledPlanId,
    resizeDisabledPlanId: props.resizeDisabledPlanId,
    onEventClick: props.onEventClick,
    onEventUpdate: props.onEventUpdate,
    onPlanRecord: props.onPlanRecord,
    onTimeRangeSelect: props.onTimeRangeSelect,
    haptic,
    startDragStore,
    updateDragStore,
    endDragStore,
  });
  latestRef.current = {
    events: props.events,
    allEvents: props.allEventsForOverlapCheck ?? props.events,
    hourHeight: props.hourHeight,
    planLaneWidthPercent: props.planLaneWidthPercent ?? DEFAULT_PLAN_LANE_WIDTH_PERCENT,
    date: props.date,
    displayDates: props.displayDates,
    viewMode: props.viewMode ?? 'day',
    disabledPlanId: props.disabledPlanId,
    resizeDisabledPlanId: props.resizeDisabledPlanId,
    onEventClick: props.onEventClick,
    onEventUpdate: props.onEventUpdate,
    onPlanRecord: props.onPlanRecord,
    onTimeRangeSelect: props.onTimeRangeSelect,
    haptic,
    startDragStore,
    updateDragStore,
    endDragStore,
  };

  // Timer ref
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cached day-column NodeList — populated at drag-start, cleared on drag-end
  const dayColumnsRef = useRef<NodeListOf<HTMLElement> | null>(null);
  // pending → dragging の初回mousemoveでも、pointer位置から解決したレーンを失わない。
  // reducer effect の DRAG_STORE_START より前にレーンを解決するため、一時refで受け渡す。
  const pendingTargetLaneRef = useRef<'plan' | 'record' | null>(null);
  // machine は DRAG_STORE_END → DROP の順でeffectを出すため、drop判定用laneを別refに保持する。
  const dragLaneRef = useRef<{ source: 'plan' | 'record'; target: 'plan' | 'record' } | null>(null);
  const interactionVersionRef = useRef<string | null>(null);

  const refs: InteractionRefs = {
    stateRef,
    timerRef,
    dayColumnsRef,
    pendingTargetLaneRef,
    dragLaneRef,
    interactionVersionRef,
  };

  // ---- Build context for the reducer ----
  function buildContext(r: InteractionRuntime): InteractionContext {
    return {
      hourHeight: r.hourHeight,
      date: r.date,
      ...(r.displayDates ? { displayDates: r.displayDates } : {}),
      viewMode: r.viewMode,
      getTimeblockDurationMs: (timeblockId: string) => {
        const event = r.events.find((e) => e.id === timeblockId);
        if (event?.startDate && event?.endDate) {
          return event.endDate.getTime() - event.startDate.getTime();
        }
        return 3600000; // default 1h
      },
      getResizeMinEndMinutes: (timeblockId: string) => {
        const event = r.events.find((candidate) => candidate.id === timeblockId);
        if (!hasCalendarActualRangeDiff(event) || !event?.actualStartDate) return null;
        return event.actualStartDate.getHours() * 60 + event.actualStartDate.getMinutes();
      },
      // 自動記録モデルでは drag / resize とも「planned のみ移動・確定済み actual は固定」で
      // 重複判定が同一なため operation は使わない（machine の API 形状だけ維持する）
      checkOverlap: (timeblockId: string, start: Date, end: Date, operation: 'drag' | 'resize') => {
        const sourceKind = r.events.find((event) => event.id === timeblockId)?.kind;
        const targetLane = pendingTargetLaneRef.current ?? dragLaneRef.current?.target;
        // レーン間dropでkindが変わるのは Plan → Record だけ。
        // RecordをPlan側へ寄せてもRecordの時間更新なので、Record同士の重複を判定する。
        const targetKind =
          operation === 'drag' &&
          sourceKind &&
          targetLane &&
          isPlanRecordDrop(sourceKind, targetLane)
            ? 'record'
            : sourceKind;
        return checkClientSideOverlapByKind(
          r.allEvents,
          timeblockId,
          start,
          end,
          targetKind ? { targetKind } : undefined,
        );
      },
    };
  }

  // ---- Stable dispatch function ----

  const dispatch = useCallback(function stableDispatch(action: InteractionAction) {
    const r = latestRef.current;
    if (
      action.type === 'POINTER_DOWN' ||
      action.type === 'TOUCH_START' ||
      action.type === 'RESIZE_START'
    ) {
      interactionVersionRef.current =
        r.events.find((event) => event.id === action.timeblockId)?.version ?? null;
    } else if (action.type === 'CANCEL') {
      interactionVersionRef.current = null;
    }
    const ctx = buildContext(r);
    const { state: next, effects } = interactionReducer(stateRef.current, action, ctx);
    stateRef.current = next;
    setRenderState(next);
    processInteractionEffects(effects, r, stableDispatch, {
      stateRef,
      timerRef,
      dayColumnsRef,
      pendingTargetLaneRef,
      dragLaneRef,
      interactionVersionRef,
    });
  }, []);

  // ---- Cleanup timer on unmount ----
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- timerRef は DOM node ではなくタイマー ID の保持用。unmount 時点の最新値を clear するのが意図
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // ---- Global event listeners / cursor ----
  useInteractionListeners({ mode: renderState.mode, dispatch, latestRef, refs });
  useInteractionCursor(renderState.mode);

  // ---- Convenience handlers ----

  const handlePointerDown = useCallback(
    (timeblockId: string, e: React.MouseEvent, position: TimeblockRect, dateIndex: number = 0) => {
      if (e.button !== 0) return;
      const r = latestRef.current;
      pendingTargetLaneRef.current = null;
      dragLaneRef.current = null;
      // 詳細を開いているブロックは drag させない。クリックはカード自身の onClick が
      // 届けるので、ここでは何もしない（touch 側と同じ扱い）。
      // かつてここで onEventClick を呼んでいたが、カードの onClick と合わせて 1 回の
      // クリックが 2 回届き、開閉のトグルが打ち消し合っていた（2026-09-10 User 指摘）
      if (r.disabledPlanId && timeblockId === r.disabledPlanId) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({
        type: 'POINTER_DOWN',
        timeblockId,
        point: getPointerPoint(e.nativeEvent),
        originalPosition: position,
        dateIndex,
      });
    },
    [dispatch],
  );

  const handleTouchStart = useCallback(
    (timeblockId: string, e: React.TouchEvent, position: TimeblockRect, dateIndex: number = 0) => {
      const r = latestRef.current;
      pendingTargetLaneRef.current = null;
      dragLaneRef.current = null;
      if (r.disabledPlanId && timeblockId === r.disabledPlanId) return;
      dispatch({
        type: 'TOUCH_START',
        timeblockId,
        point: getPointerPoint(e.nativeEvent),
        originalPosition: position,
        dateIndex,
      });
    },
    [dispatch],
  );

  const handleResizeStart = useCallback(
    (
      timeblockId: string,
      direction: 'top' | 'bottom',
      e: React.MouseEvent | React.TouchEvent,
      position: TimeblockRect,
    ) => {
      // マウスイベントの場合は左クリックのみ許可
      if ('button' in e && e.button !== 0) return;
      const r = latestRef.current;
      if (r.resizeDisabledPlanId && timeblockId === r.resizeDisabledPlanId) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({
        type: 'RESIZE_START',
        timeblockId,
        direction,
        point: getPointerPoint(e.nativeEvent),
        originalPosition: position,
      });
    },
    [dispatch],
  );

  return {
    state: renderState,
    dispatch,
    handlers: {
      handlePointerDown,
      handleTouchStart,
      handleResizeStart,
    },
  };
}
