import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type { HoveredActivityInfo } from '@/features/activities';
import { createSelectors } from '@/lib/zustand/createSelectors';

/**
 * ドラッグ選択による作成の状態管理
 *
 * ドラッグ終了 → pendingSelection セット → グリッドに DragSelectionHighlight を描き、
 * 同時に Inspector を作成モード（InlineCreatePanel）で開く。
 * アクティビティ選択で作成、パネルを閉じると破棄 → clearPendingSelection。
 */

/** ドラッグ選択で確定した時間範囲 */
interface PendingSelection {
  date: Date;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  creationSource?: 'planned-gap' | undefined;
  /** Step 5 のレーン起点。保存先は最終的に end_at のルールが優先する。 */
  lane?: 'plan' | 'record' | undefined;
  /**
   * ユーザーがタブで選んだ種別。未指定なら end_at の既定判定に従う。
   * 未来スロット（end_at > now）では要求に関わらず plan になる（DT005）。
   */
  kind?: 'plan' | 'record' | undefined;
}

interface InlineCreateState {
  pendingSelection: PendingSelection | null;
  /**
   * 作成パネルでホバー中のアクティビティ。グリッドのハイライトが色と名前を先出しする。
   * パネルとハイライトは別コンポーネントなので、hook の local state では伝わらない。
   */
  hoveredActivity: HoveredActivityInfo | null;
  setHoveredActivity: (activity: HoveredActivityInfo | null) => void;
  setPendingSelection: (selection: PendingSelection) => void;
  clearPendingSelection: () => void;
  /** ユーザーが選んだ種別を設定する（null 時 no-op） */
  setSelectionKind: (kind: 'plan' | 'record') => void;
  /** 作成パネルの日付入力から対象日を差し替える（null 時 no-op） */
  setSelectionDate: (date: Date) => void;
  /** 既存 pendingSelection の時間フィールドを部分更新する（null 時 no-op） */
  updateSelectionTimes: (
    partial: Partial<Pick<PendingSelection, 'startHour' | 'startMinute' | 'endHour' | 'endMinute'>>,
  ) => void;
}

const useInlineCreateStoreBase = create<InlineCreateState>()(
  devtools(
    (set) => ({
      pendingSelection: null,
      hoveredActivity: null,
      setHoveredActivity: (activity) => set({ hoveredActivity: activity }),
      setPendingSelection: (selection) => set({ pendingSelection: selection }),
      clearPendingSelection: () => set({ pendingSelection: null, hoveredActivity: null }),
      setSelectionKind: (kind) =>
        set((state) =>
          state.pendingSelection
            ? { pendingSelection: { ...state.pendingSelection, kind } }
            : state,
        ),
      setSelectionDate: (date) =>
        set((state) =>
          state.pendingSelection
            ? { pendingSelection: { ...state.pendingSelection, date } }
            : state,
        ),
      updateSelectionTimes: (partial) =>
        set((state) =>
          state.pendingSelection
            ? { pendingSelection: { ...state.pendingSelection, ...partial } }
            : state,
        ),
    }),
    { name: 'inline-create-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);

/** インライン作成ストア（セレクタ付き） */
export const useInlineCreateStore = createSelectors(useInlineCreateStoreBase);
