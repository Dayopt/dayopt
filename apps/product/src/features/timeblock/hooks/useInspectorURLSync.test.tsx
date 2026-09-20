import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTimeblockInspectorStore } from '../stores/useTimeblockInspectorStore';

vi.mock('next/navigation', () => ({
  usePathname: () => '/ja/calendar',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useInspectorURLSync } from './useInspectorURLSync';

describe('useInspectorURLSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/ja/calendar');
    useTimeblockInspectorStore.getState().closeInspector();
  });

  it('同じUUIDでplanからrecordへ切り替えた時もURLを更新する', () => {
    renderHook(() => useInspectorURLSync());

    act(() => useTimeblockInspectorStore.getState().openInspector('same-id', 'plan'));
    expect(window.location.search).toBe('?timeblock=plan%3Asame-id');

    act(() => useTimeblockInspectorStore.getState().openInspector('same-id', 'record'));
    expect(window.location.search).toBe('?timeblock=record%3Asame-id');
  });

  it('開く時は client navigation を起こさず履歴だけ積む（パネルをまたたかせない）', () => {
    const lengthBefore = window.history.length;
    renderHook(() => useInspectorURLSync());

    act(() => useTimeblockInspectorStore.getState().openInspector('plan-1', 'plan'));

    expect(window.location.search).toBe('?timeblock=plan%3Aplan-1');
    expect(window.history.length).toBeGreaterThan(lengthBefore);
  });

  it('閉じた直後に古い searchParams が届いても開き直さない', () => {
    const { rerender } = renderHook(() => useInspectorURLSync());

    act(() => useTimeblockInspectorStore.getState().openInspector('plan-1', 'plan'));
    act(() => useTimeblockInspectorStore.getState().closeInspector());
    expect(window.location.search).toBe('');

    // 遅れて届く navigation の再描画を模す（URL は既に param 無しへ戻っている）
    rerender();

    expect(useTimeblockInspectorStore.getState().isOpen).toBe(false);
  });

  it('popstateで同じUUIDのkindだけが変わった場合もstoreを更新する', () => {
    useTimeblockInspectorStore.getState().openInspector('same-id', 'plan');
    renderHook(() => useInspectorURLSync());

    window.history.replaceState({}, '', '/ja/calendar?timeblock=record%3Asame-id');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: 'same-id',
      timeblockKind: 'record',
      isOpen: true,
    });
  });

  it('初期URLのrecordを正しいUUIDで開く', () => {
    window.history.replaceState({}, '', '/ja/calendar?timeblock=record%3Arecord-id');
    renderHook(() => useInspectorURLSync());
    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: 'record-id',
      timeblockKind: 'record',
      isOpen: true,
    });
  });

  it('client navigationで追加されたURLパラメータへ追従する', () => {
    const { rerender } = renderHook(() => useInspectorURLSync());

    window.history.replaceState({}, '', '/ja/calendar?timeblock=plan%3Asearched-plan');
    rerender();

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: 'searched-plan',
      timeblockKind: 'plan',
      isOpen: true,
    });
  });

  it('storeから閉じた時はURLパラメータを削除し、直前のURLから開き直さない', () => {
    window.history.replaceState({}, '', '/ja/calendar?timeblock=record%3Arecord-id');
    renderHook(() => useInspectorURLSync());

    act(() => useTimeblockInspectorStore.getState().closeInspector());

    expect(window.location.pathname + window.location.search).toBe('/ja/calendar');
    expect(useTimeblockInspectorStore.getState().isOpen).toBe(false);
  });

  it('閉じたInspectorと同じURLパラメータを再指定すると開き直す', () => {
    window.history.replaceState({}, '', '/ja/calendar?timeblock=record%3Arecord-id');
    const { rerender } = renderHook(() => useInspectorURLSync());

    act(() => useTimeblockInspectorStore.getState().closeInspector());
    expect(window.location.pathname + window.location.search).toBe('/ja/calendar');

    window.history.replaceState({}, '', '/ja/calendar?timeblock=record%3Arecord-id');
    rerender();

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: 'record-id',
      timeblockKind: 'record',
      isOpen: true,
    });
  });

  it('旧log URLは受理しない', () => {
    window.history.replaceState({}, '', '/ja/calendar?timeblock=log%3Alegacy-id');
    renderHook(() => useInspectorURLSync());
    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: null,
      isOpen: false,
    });
  });
});
