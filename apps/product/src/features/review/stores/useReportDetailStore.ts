'use client';

/**
 * 詳細パネル（仕様 §6）の開閉状態と幅。
 *
 * **開閉は persist しない。** フィルタ・レンズ（`useReportViewStore`）は「この画面をどう読むか」
 * で端末に残す価値があるが、パネルが開いていたかどうかは次に開いた時に引き継ぐ意味が無い。
 * 期間移動でも閉じる（仕様 §5）ので、寿命は 1 回の閲覧より短い。
 *
 * **幅だけ persist する。** 一度広げた人は次も広い面で読む。アカウント同期はしない（見え方の
 * 設定はフィルタと同じく端末ローカル）。
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { platformStorage } from '@/lib/zustand/storage';

import {
  clampReportDetailPanelWidth,
  REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
} from '../lib/report-detail-slot';

/**
 * 表示中の対象。
 *
 * 章の行・点が既に持っている値をそのまま預かる。ここで持たずに ID だけ渡すと、パネルが
 * 名前とカテゴリーを引くためだけに期間集計をもう一度読むことになる。
 */
export interface ReportDetailTarget {
  /** `null` はアクティビティ未設定の記録。 */
  activityId: string | null;
  name: string | null;
  categoryName: string | null;
  /** カテゴリー色（10 色名）。表示側が semantic token へ写す。 */
  color: string | null;
}

interface ReportDetailState {
  isOpen: boolean;
  /** 表示中の対象。閉じている時は `null`。 */
  target: ReportDetailTarget | null;
  /** パネルの幅（px）。persist する唯一の値。 */
  width: number;
  /** ドラッグ中か。true の間は shell が幅のトランジションを切る（persist しない）。 */
  isResizing: boolean;
}

interface ReportDetailActions {
  /** 同じ対象なら閉じ、別の対象なら中身を差し替える（仕様 §5）。 */
  toggle: (target: ReportDetailTarget) => void;
  close: () => void;
  /** 幅を変える。範囲外は clamp する。 */
  setWidth: (width: number) => void;
  setResizing: (isResizing: boolean) => void;
}

type ReportDetailStore = ReportDetailState & ReportDetailActions;

/** persist する形。開閉と対象は載せない。 */
interface ReportDetailPersistedState {
  width: number;
}

/**
 * 永続化された幅を現在の形へ寄せる。
 *
 * localStorage は他バージョンの Dayopt・拡張・手編集で壊れうる。数値でない値や範囲外の値を
 * そのまま入れると、パネルが 0px や画面幅いっぱいで開いて操作できなくなる。
 * `useReportViewStore` と同じく `merge` からも通すので、version が一致したまま中身が
 * 壊れている場合も素通りしない。
 */
export function sanitizeReportDetailPersistedState(
  persistedState: unknown,
): ReportDetailPersistedState {
  if (typeof persistedState !== 'object' || persistedState === null) {
    return { width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH };
  }

  const width = Reflect.get(persistedState, 'width');
  if (typeof width !== 'number') return { width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH };
  return { width: clampReportDetailPanelWidth(width) };
}

export const useReportDetailStore = create<ReportDetailStore>()(
  devtools(
    persist<ReportDetailStore, [], [], ReportDetailPersistedState>(
      (set) => ({
        isOpen: false,
        target: null,
        width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
        isResizing: false,

        // devtools は persist の外側なので、set に action 名は渡せない（型が受けない）
        toggle: (target) =>
          set((state) =>
            // `activityId` は null を取りうるので、開閉の判定に `isOpen` を必ず含める
            state.isOpen && state.target?.activityId === target.activityId
              ? { isOpen: false, target: null }
              : { isOpen: true, target },
          ),

        close: () => set({ isOpen: false, target: null }),

        setWidth: (width) => set({ width: clampReportDetailPanelWidth(width) }),

        setResizing: (isResizing) => set({ isResizing }),
      }),
      {
        name: 'report-detail-storage',
        version: 1,
        storage: platformStorage<ReportDetailPersistedState>(),
        partialize: ({ width }) => ({ width }),
        migrate: (persistedState) => sanitizeReportDetailPersistedState(persistedState),
        // version が一致していてもここは通る。壊れた値を state へ入れない最後の関門。
        // hydrate は replace 呼び出しなので `...currentState` で action を保つ
        merge: (persistedState, currentState) => ({
          ...currentState,
          ...sanitizeReportDetailPersistedState(persistedState),
        }),
      },
    ),
    { name: 'ReportDetailStore' },
  ),
);
