import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShellStore } from '@/lib/stores/useShellStore';

import { useTimeblockInspectorStore } from '@/features/timeblock';

import { AUTO_UPDATE_RELOAD_KEY, useApplyUpdateWhenSafe } from './useApplyUpdateWhenSafe';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function renderApply(
  props: { updateAvailable: boolean; latestVersion: string | null },
  queryClient = new QueryClient(),
) {
  const applyUpdate = vi.fn();
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const view = renderHook(
    (current: { updateAvailable: boolean; latestVersion: string | null }) =>
      useApplyUpdateWhenSafe({ ...current, applyUpdate }),
    { initialProps: props, wrapper },
  );
  return { ...view, applyUpdate };
}

describe('useApplyUpdateWhenSafe', () => {
  beforeEach(() => {
    setVisibility('visible');
    window.sessionStorage.clear();
    useTimeblockInspectorStore.getState().closeInspector();
    useShellStore.getState().closeSheet();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('古くなければ何もしない', () => {
    const { applyUpdate } = renderApply({ updateAvailable: false, latestVersion: null });

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('古く、見えていて、編集中でなければリロードする', () => {
    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(AUTO_UPDATE_RELOAD_KEY)).toBe('99999999');
  });

  it('同じ版へ向けてリロード済みなら繰り返さない', () => {
    window.sessionStorage.setItem(AUTO_UPDATE_RELOAD_KEY, '99999999');

    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('前回と違う版なら再びリロードする', () => {
    window.sessionStorage.setItem(AUTO_UPDATE_RELOAD_KEY, '11111111');

    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).toHaveBeenCalledOnce();
  });

  it('タブが見えていない間はリロードせず、戻った時にリロードする', () => {
    setVisibility('hidden');
    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });
    expect(applyUpdate).not.toHaveBeenCalled();

    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(applyUpdate).toHaveBeenCalledOnce();
  });

  it('保存中の mutation がある間はリロードしない', () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, 'isMutating').mockReturnValue(1);

    const { applyUpdate } = renderApply(
      { updateAvailable: true, latestVersion: '99999999' },
      queryClient,
    );

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('Inspector が作成モードの間はリロードしない', () => {
    useTimeblockInspectorStore.getState().openCreate();

    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('モーダル / シートが開いている間はリロードしない', () => {
    useShellStore.getState().openSettings();

    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('入力欄にフォーカスがある間はリロードしない', () => {
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    const { applyUpdate } = renderApply({ updateAvailable: true, latestVersion: '99999999' });

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('編集中に検知したら、編集を終えた瞬間ではなく次にタブへ戻った時にリロードする', () => {
    useTimeblockInspectorStore.getState().openCreate();
    const { applyUpdate, rerender } = renderApply({
      updateAvailable: true,
      latestVersion: '99999999',
    });

    act(() => {
      useTimeblockInspectorStore.getState().closeInspector();
    });
    rerender({ updateAvailable: true, latestVersion: '99999999' });
    expect(applyUpdate).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(applyUpdate).toHaveBeenCalledOnce();
  });
});
