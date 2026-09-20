import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { CalendarDisplayEvent } from '../types/calendar.types';

/**
 * カレンダーのドラッグ状態を管理するストア
 *
 * 日付間ドラッグ移動をサポートするため、
 * 複数のコンテンツコンポーネント（WeekContent等）で
 * ドラッグ状態を共有する
 */

interface CalendarDragState {
  /** ドラッグ中のTimeblockID */
  draggedTimeblockId: string | null;
  /** ドラッグ中のTimeblockデータ */
  draggedTimeblock: CalendarDisplayEvent | null;
  /** 元の日付インデックス */
  originalDateIndex: number;
  /** 現在のターゲット日付インデックス */
  targetDateIndex: number;
  /** ドラッグ中かどうか */
  isDragging: boolean;
  /** プレビュー時間 */
  previewTime: { start: Date; end: Date } | null;
  /** スナップされた位置（top, height） */
  snappedPosition: { top: number; height?: number } | null;
  /** Step 5 の 2 レーン接続用。Plan → Record は record mutation に委譲する。 */
  sourceLane: 'plan' | 'record' | null;
  targetLane: 'plan' | 'record' | null;
}

interface CalendarDragActions {
  /** カレンダー内ドラッグ開始 */
  startDrag: (
    timeblockId: string,
    timeblock: CalendarDisplayEvent,
    dateIndex: number,
    lane?: 'plan' | 'record',
  ) => void;
  /** ドラッグ中の状態更新 */
  updateDrag: (
    updates: Partial<Omit<CalendarDragState, 'draggedTimeblockId' | 'draggedTimeblock'>>,
  ) => void;
  /** ドラッグ終了 */
  endDrag: () => void;
}

const initialState: CalendarDragState = {
  draggedTimeblockId: null,
  draggedTimeblock: null,
  originalDateIndex: 0,
  targetDateIndex: 0,
  isDragging: false,
  previewTime: null,
  snappedPosition: null,
  sourceLane: null,
  targetLane: null,
};

/** カレンダーのドラッグ状態を管理するZustandストア */
export const useCalendarDragStore = create<CalendarDragState & CalendarDragActions>()(
  devtools(
    (set) => ({
      ...initialState,

      startDrag: (timeblockId, timeblock, dateIndex, lane = 'plan') =>
        set({
          draggedTimeblockId: timeblockId,
          draggedTimeblock: timeblock,
          originalDateIndex: dateIndex,
          targetDateIndex: dateIndex,
          isDragging: true,
          previewTime: null,
          snappedPosition: null,
          sourceLane: lane,
          targetLane: lane,
        }),

      updateDrag: (updates) =>
        set((state) => ({
          ...state,
          ...updates,
        })),

      endDrag: () => set(initialState),
    }),
    { name: 'calendar-drag-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
