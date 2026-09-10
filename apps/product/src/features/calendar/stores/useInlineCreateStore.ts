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
 *
 * アクティビティにホバーすると、その「普段の長さ」（記録の中央値）を選択範囲へ着せる
 * （`previewActivityDuration`）。プレビューと作成が食い違わないよう、着せる先は表示用の
 * 別状態ではなく pendingSelection 自身にする。グリッドのハイライト・パネルの時刻入力・
 * 重なり判定・作成が同じ 1 つの値を読む。
 *
 * ただしユーザーが時間を直した後は着せない。ドラッグは「どこに置くか」の指定だが、
 * リサイズや時刻入力は「どれだけの長さにするか」の明示的な指定なので、そちらを優先する。
 */

/** 1 日の終端（23:59）。`createInstantSelection` と同じクランプ規則を使う */
const MAX_END_MINUTES = 24 * 60 - 1;

function durationMinutesOf(selection: {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}): number {
  return (
    selection.endHour * 60 +
    selection.endMinute -
    (selection.startHour * 60 + selection.startMinute)
  );
}

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
  /**
   * ドラッグで決めた長さ（分）。ホバーを外した時・中央値の無いアクティビティへ移った時に
   * ここへ戻す。
   */
  baseDurationMinutes: number | null;
  /**
   * ユーザーがリサイズや時刻入力で長さを直したか。直した後はアクティビティの
   * 普段の長さで上書きしない。
   */
  hasUserSetDuration: boolean;
  setHoveredActivity: (activity: HoveredActivityInfo | null) => void;
  /**
   * ホバー中のアクティビティの普段の長さ（分）を選択範囲へ着せる。
   * `null` を渡すとドラッグで決めた長さへ戻す。長さを直した後は no-op。
   */
  previewActivityDuration: (minutes: number | null) => void;
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
      baseDurationMinutes: null,
      hasUserSetDuration: false,
      setHoveredActivity: (activity) => set({ hoveredActivity: activity }),
      previewActivityDuration: (minutes) =>
        set((state) => {
          const selection = state.pendingSelection;
          // ユーザーが長さを直した後は着せ替えない（明示の指定が勝つ）
          if (!selection || state.hasUserSetDuration) return state;
          const target = minutes ?? state.baseDurationMinutes;
          if (target == null) return state;
          const startTotal = selection.startHour * 60 + selection.startMinute;
          const endTotal = Math.min(startTotal + target, MAX_END_MINUTES);
          const endHour = Math.floor(endTotal / 60);
          const endMinute = endTotal % 60;
          if (endHour === selection.endHour && endMinute === selection.endMinute) return state;
          return { pendingSelection: { ...selection, endHour, endMinute } };
        }),
      setPendingSelection: (selection) =>
        set({
          pendingSelection: selection,
          baseDurationMinutes: durationMinutesOf(selection),
          hasUserSetDuration: false,
        }),
      clearPendingSelection: () =>
        set({
          pendingSelection: null,
          hoveredActivity: null,
          baseDurationMinutes: null,
          hasUserSetDuration: false,
        }),
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
        set((state) => {
          const selection = state.pendingSelection;
          if (!selection) return state;
          const next = { ...selection, ...partial };
          // 長さが変わった時だけ「ユーザーが指定した」と見なす。long-press 移動のように
          // 長さを保ったまま位置だけ動かす操作は、着せ替えを止める理由にならない
          const nextDuration = durationMinutesOf(next);
          if (nextDuration === durationMinutesOf(selection)) return { pendingSelection: next };
          return {
            pendingSelection: next,
            baseDurationMinutes: nextDuration,
            hasUserSetDuration: true,
          };
        }),
    }),
    { name: 'inline-create-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);

/** インライン作成ストア（セレクタ付き） */
export const useInlineCreateStore = createSelectors(useInlineCreateStoreBase);
