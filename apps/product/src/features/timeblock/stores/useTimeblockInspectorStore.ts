import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type { HoveredActivityInfo } from '@/features/activities';

import type { TimeblockDestination } from '../domain/timeblock-destination';
import type { TimeblockDuplicateDraft } from '../lib/timeblock-duplicate';

/**
 * Timeblock Inspector 状態管理
 *
 * Plan / Record に対応。timeblockKind で対象を判別する。
 */

/**
 * Timeblock Inspector Store の状態
 */
interface TimeblockInspectorState {
  /** Inspector が開いているか */
  isOpen: boolean;
  /** 対象エントリのID（plan または record の UUID） */
  timeblockId: string | null;
  /** 対象が plan / record のどちらか */
  timeblockKind: TimeblockDestination;
  /** 複製時だけ保持する独立新規ブロックの下書き。 */
  duplicateDraft: TimeblockDuplicateDraft | null;
  /**
   * ドラッグ作成モード。calendar 側の pendingSelection を元に、同じパネルで
   * アクティビティを選ぶ。timeblockId は null（URL 同期しない）。
   */
  createMode: boolean;
  /**
   * アクティビティ選択でホバー中の値。開いているブロックのカードが、
   * 選ぶ前に色・アイコン・名前を先出しする（作成時のハイライトと同じ扱い）。
   */
  hoveredActivity: HoveredActivityInfo | null;
}

/**
 * Timeblock Inspector Store のアクション
 */
interface TimeblockInspectorActions {
  /** Inspector を開く */
  openInspector: (timeblockId: string, kind?: TimeblockDestination) => void;
  /** 元ブロックを参照しながら複製下書きを開く。 */
  openDuplicate: (draft: TimeblockDuplicateDraft) => void;
  /** 複製を取り消して元ブロックの詳細へ戻る。 */
  cancelDuplicate: () => void;
  /** ドラッグ作成モードで開く（アクティビティ選択 → 作成）。 */
  openCreate: () => void;
  /** アクティビティ選択のホバーを反映する（離れたら null）。 */
  setHoveredActivity: (activity: HoveredActivityInfo | null) => void;
  /** Inspector を閉じる */
  closeInspector: () => void;
}

/**
 * Timeblock Inspector Store 型
 */
type TimeblockInspectorStore = TimeblockInspectorState & TimeblockInspectorActions;

/** Timeblock Inspector の開閉状態・対象Timeblock ID・kind を管理するストア */
export const useTimeblockInspectorStore = create<TimeblockInspectorStore>()(
  devtools(
    (set) => ({
      isOpen: false,
      timeblockId: null,
      timeblockKind: 'plan',
      duplicateDraft: null,
      createMode: false,
      hoveredActivity: null,

      setHoveredActivity: (activity) =>
        set({ hoveredActivity: activity }, false, 'setHoveredActivity'),

      openInspector: (timeblockId, kind = 'plan') =>
        set(
          {
            isOpen: true,
            timeblockId,
            timeblockKind: kind,
            duplicateDraft: null,
            createMode: false,
            hoveredActivity: null,
          },
          false,
          'openInspector',
        ),

      openDuplicate: (draft) =>
        set(
          {
            isOpen: true,
            timeblockId: draft.sourceId,
            timeblockKind: draft.kind,
            duplicateDraft: draft,
            createMode: false,
            hoveredActivity: null,
          },
          false,
          'openDuplicate',
        ),

      openCreate: () =>
        set(
          {
            isOpen: true,
            timeblockId: null,
            timeblockKind: 'plan',
            duplicateDraft: null,
            createMode: true,
            hoveredActivity: null,
          },
          false,
          'openCreate',
        ),

      cancelDuplicate: () => set({ duplicateDraft: null }, false, 'cancelDuplicate'),

      closeInspector: () => {
        // カレンダーのドラッグ選択をクリア
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('calendar-drag-cancel'));
        }
        set(
          {
            isOpen: false,
            timeblockId: null,
            timeblockKind: 'plan',
            duplicateDraft: null,
            createMode: false,
            hoveredActivity: null,
          },
          false,
          'closeInspector',
        );
      },
    }),
    { name: 'timeblock-inspector-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
