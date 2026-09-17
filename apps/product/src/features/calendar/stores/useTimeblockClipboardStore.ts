'use client';

import type { ClipboardTimeblock } from '@/features/timeblock';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type { ClipboardTimeblock } from '@/features/timeblock';

/**
 * 最後にクリックした日付（Googleカレンダー互換のペースト用）
 * 時刻はコピー元のものを使用するため、日付のみ記憶
 */
interface LastClickedPosition {
  date: Date;
}

interface TimeblockClipboardState {
  /** コピーされたタイムブロック */
  copiedTimeblock: ClipboardTimeblock | null;
  /** 最後にクリックした位置（Cmd+Vでペーストする位置） */
  lastClickedPosition: LastClickedPosition | null;
}

interface TimeblockClipboardActions {
  /** タイムブロックをクリップボードにコピー */
  copyTimeblock: (timeblock: ClipboardTimeblock) => void;
  /** クリップボードをクリア */
  clearClipboard: () => void;
  /** クリップボードにタイムブロックがあるかチェック */
  hasCopiedTimeblock: () => boolean;
  /** 最後にクリックした位置を設定（Googleカレンダー互換のCmd+Vペースト用） */
  setLastClickedPosition: (position: LastClickedPosition) => void;
  /** 最後にクリックした位置をクリア */
  clearLastClickedPosition: () => void;
}

type TimeblockClipboardStore = TimeblockClipboardState & TimeblockClipboardActions;

/**
 * タイムブロッククリップボードStore
 *
 * タイムブロックのコピー＆ペースト機能用のクリップボード管理
 * - コピー: タイムブロックの情報を保存
 * - ペースト: 保存された情報を使って新規タイムブロックをドラフトモードで作成
 */
export const useTimeblockClipboardStore = create<TimeblockClipboardStore>()(
  devtools(
    (set, get) => ({
      // State
      copiedTimeblock: null,
      lastClickedPosition: null,

      // Actions
      copyTimeblock: (timeblock) => {
        set({ copiedTimeblock: timeblock });
      },

      clearClipboard: () => {
        set({ copiedTimeblock: null });
      },

      hasCopiedTimeblock: () => {
        return get().copiedTimeblock !== null;
      },

      setLastClickedPosition: (position) => {
        set({ lastClickedPosition: position });
      },

      clearLastClickedPosition: () => {
        set({ lastClickedPosition: null });
      },
    }),
    { name: 'timeblock-clipboard-store', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
