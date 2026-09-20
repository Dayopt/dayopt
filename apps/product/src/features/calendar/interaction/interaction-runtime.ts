'use client';

/**
 * useInteraction の入出力型と runtime 参照バンドル
 *
 * hook 本体（useInteraction.ts）、effect 処理（interaction-effects.ts）、
 * グローバルリスナー（useInteractionListeners.ts）で共有する型定義。
 */

import type React from 'react';

import type { useHapticFeedback } from '../hooks/accessibility/useHapticFeedback';
import type { useCalendarDragStore } from '../stores/useCalendarDragStore';
import type { CalendarDisplayEvent } from '../types/calendar.types';

import type {
  InteractionAction,
  InteractionState,
  TimeblockRect,
  TimeRange,
} from '../domain/interaction/types';

/** useInteraction フックへの入力プロパティ */
export interface UseInteractionProps {
  /** Base date of the current view */
  date: Date;
  /** Events for the current view */
  events: CalendarDisplayEvent[];
  /** Events for overlap checking (defaults to events) */
  allEventsForOverlapCheck?: CalendarDisplayEvent[];
  /** Displayed dates (week/multi-day views) */
  displayDates?: Date[];
  /** View mode */
  viewMode?: 'day' | '3day' | '5day' | 'week';
  /** Plan ID to disable dragging (e.g. Inspector-open plan) */
  disabledPlanId?: string | null;
  /** Plan ID to disable resize（move とは独立に制御するため）。Mobile では Inspector 開いている timeblock も resize 可にしたい場合 null を渡す */
  resizeDisabledPlanId?: string | null;
  /** Pixels per hour */
  hourHeight: number;
  /** 2レーン表示のPlan幅（%） */
  planLaneWidthPercent?: number | undefined;
  /** Callback when an event is moved or resized */
  onEventUpdate?: (
    eventId: string,
    updates: {
      startTime: Date;
      endTime: Date;
      resetActualTime?: boolean;
      expectedUpdatedAt?: string;
    },
  ) => Promise<void | { skipToast: true }> | void;
  /** Plan を Record レーンへdropした時の記録化 */
  onPlanRecord?: ((planId: string, range: TimeRange) => void) | undefined;
  /** Callback when an event is clicked (not dragged) */
  onEventClick?: (event: CalendarDisplayEvent) => void;
  /** Callback when a time range is selected on the grid */
  onTimeRangeSelect?: (selection: {
    date: Date;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    /** グリッドで範囲を引いた選択。普段の長さで上書きしない */
    durationSource: 'dragged';
  }) => void;
}

/** useInteraction フックの戻り値 */
export interface UseInteractionReturn {
  /** Current interaction state (discriminated union) */
  state: InteractionState;
  /** Low-level dispatch for custom integrations */
  dispatch: (action: InteractionAction) => void;
  /** Convenience handlers for attaching to DOM elements */
  handlers: InteractionHandlers;
}

/** DOM要素にアタッチするインタラクションハンドラー群 */
export interface InteractionHandlers {
  handlePointerDown: (
    timeblockId: string,
    e: React.MouseEvent,
    position: TimeblockRect,
    dateIndex?: number,
  ) => void;
  handleTouchStart: (
    timeblockId: string,
    e: React.TouchEvent,
    position: TimeblockRect,
    dateIndex?: number,
  ) => void;
  handleResizeStart: (
    timeblockId: string,
    direction: 'top' | 'bottom',
    e: React.MouseEvent | React.TouchEvent,
    position: TimeblockRect,
  ) => void;
}

type CalendarDragStoreState = ReturnType<typeof useCalendarDragStore.getState>;

/** latestRef.current の形。stable dispatch から毎回読む可変依存の束 */
export interface InteractionRuntime {
  events: CalendarDisplayEvent[];
  allEvents: CalendarDisplayEvent[];
  hourHeight: number;
  planLaneWidthPercent: number;
  date: Date;
  displayDates: Date[] | undefined;
  viewMode: 'day' | '3day' | '5day' | 'week';
  disabledPlanId: string | null | undefined;
  resizeDisabledPlanId: string | null | undefined;
  onEventClick: UseInteractionProps['onEventClick'];
  onEventUpdate: UseInteractionProps['onEventUpdate'];
  onPlanRecord: UseInteractionProps['onPlanRecord'];
  onTimeRangeSelect: UseInteractionProps['onTimeRangeSelect'];
  haptic: ReturnType<typeof useHapticFeedback>;
  startDragStore: CalendarDragStoreState['startDrag'];
  updateDragStore: CalendarDragStoreState['updateDrag'];
  endDragStore: CalendarDragStoreState['endDrag'];
}

/** hook 内の mutable ref の束（effect 処理・リスナーと共有する） */
export interface InteractionRefs {
  /** authoritative な現在状態（stale closure 回避用） */
  stateRef: React.MutableRefObject<InteractionState>;
  /** ロングプレスタイマー */
  timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  /** drag 開始時にキャッシュする day-column NodeList */
  dayColumnsRef: React.MutableRefObject<NodeListOf<HTMLElement> | null>;
  /** pending → dragging の初回 mousemove で解決したレーンの受け渡し */
  pendingTargetLaneRef: React.MutableRefObject<'plan' | 'record' | null>;
  /** drop 判定用の source / target レーン */
  dragLaneRef: React.MutableRefObject<{
    source: 'plan' | 'record';
    target: 'plan' | 'record';
  } | null>;
  /** drag / resize開始時にユーザーが見ていたraw DB version。 */
  interactionVersionRef: React.MutableRefObject<string | null>;
}
