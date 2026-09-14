'use client';

import { useCallback, useEffect } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { useShellStore } from '@/lib/stores/useShellStore';

import { useTimeblockInspectorStore } from '@/features/timeblock';

/** 同じ版へ向けた自動リロードを 1 タブ 1 回に抑える sessionStorage のキー */
export const AUTO_UPDATE_RELOAD_KEY = 'dayopt:auto-update-reloaded';

interface ApplyUpdateWhenSafeOptions {
  /** 表示中のページが最新ビルドより古いか */
  updateAvailable: boolean;
  /** 検知した最新ビルドの版（分からなければ null） */
  latestVersion: string | null;
  /** ページをリロードする */
  applyUpdate: () => void;
}

function isEditableElementFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return active.matches('input, textarea, select');
}

function readReloadedVersion(): string | null {
  try {
    return window.sessionStorage.getItem(AUTO_UPDATE_RELOAD_KEY);
  } catch {
    return null;
  }
}

function markReloaded(version: string): boolean {
  try {
    window.sessionStorage.setItem(AUTO_UPDATE_RELOAD_KEY, version);
    return true;
  } catch {
    // flag を保持できない環境ではリロードループを防げないので自動では適用しない
    return false;
  }
}

/**
 * 古いビルドのまま開いているページを、編集を失わない瞬間にだけ黙ってリロードする
 *
 * 更新の通知 UI は持たない。次のどれかに当たる間は何もせず、次にタブへ戻った時に判定し直す。
 * 「安全になった瞬間」には追いかけてリロードしない。直前まで操作していた画面が消えるため。
 *
 * - タブが見えていない
 * - 保存中の mutation がある（楽観的更新の確定前）
 * - Inspector が作成モードか複製の下書きを持っている（保存前の入力が store にしかない）
 * - モーダル / シートが開いている
 * - 入力欄にフォーカスがある
 *
 * 同じ版へ向けたリロードは sessionStorage で 1 回に抑える。配信の反映遅れでリロード後も
 * 古いままだった場合に、リロードを繰り返さないため。
 */
export function useApplyUpdateWhenSafe({
  updateAvailable,
  latestVersion,
  applyUpdate,
}: ApplyUpdateWhenSafeOptions): void {
  const queryClient = useQueryClient();

  const tryApply = useCallback(() => {
    if (!updateAvailable) return;
    if (document.visibilityState !== 'visible') return;
    if (queryClient.isMutating() > 0) return;

    const inspector = useTimeblockInspectorStore.getState();
    if (inspector.createMode || inspector.duplicateDraft !== null) return;
    if (useShellStore.getState().activeSheet !== null) return;
    if (isEditableElementFocused()) return;

    const version = latestVersion ?? 'unknown';
    if (readReloadedVersion() === version) return;
    if (!markReloaded(version)) return;

    applyUpdate();
  }, [updateAvailable, latestVersion, applyUpdate, queryClient]);

  useEffect(() => {
    tryApply();
  }, [tryApply]);

  useEffect(() => {
    document.addEventListener('visibilitychange', tryApply);
    return () => document.removeEventListener('visibilitychange', tryApply);
  }, [tryApply]);
}
