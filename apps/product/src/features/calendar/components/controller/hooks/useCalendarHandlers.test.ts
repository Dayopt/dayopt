/**
 * ブロックのクリックで詳細パネルを開閉するルール。
 *
 * 開けた操作と同じ操作で閉じられるようにする（トグル）。ただし複製の下書き中は
 * 閉じない — 下書きを黙って捨てることになるため。
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../../types/calendar.types';

const openInspector = vi.hoisted(() => vi.fn());
const closeInspector = vi.hoisted(() => vi.fn());
const openCreate = vi.hoisted(() => vi.fn());
const inspectorState = vi.hoisted(() => ({
  value: {
    isOpen: false,
    timeblockId: null as string | null,
    duplicateDraft: null as unknown,
  },
}));

vi.mock('@/features/timeblock', () => ({
  useTimeblockInspectorStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...inspectorState.value,
      openInspector,
      closeInspector,
      openCreate,
    }),
}));

vi.mock('../../../stores/useInlineCreateStore', () => ({
  useInlineCreateStore: { use: { setPendingSelection: () => vi.fn() } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { useCalendarHandlers } = await import('./useCalendarHandlers');

const entry = { id: 'plan-1', title: '開発', kind: 'plan' } as unknown as CalendarDisplayEvent;

describe('useCalendarHandlers.handleTimeblockClick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectorState.value = { isOpen: false, timeblockId: null, duplicateDraft: null };
  });

  it('閉じている時は開く', () => {
    const { result } = renderHook(() => useCalendarHandlers());

    result.current.handleTimeblockClick(entry);

    expect(openInspector).toHaveBeenCalledWith('plan-1', 'plan');
    expect(closeInspector).not.toHaveBeenCalled();
  });

  it('開いているブロックをもう一度押したら閉じる', () => {
    inspectorState.value = { isOpen: true, timeblockId: 'plan-1', duplicateDraft: null };
    const { result } = renderHook(() => useCalendarHandlers());

    result.current.handleTimeblockClick(entry);

    expect(closeInspector).toHaveBeenCalledTimes(1);
    expect(openInspector).not.toHaveBeenCalled();
  });

  it('別のブロックを押したらそちらへ開き直す', () => {
    inspectorState.value = { isOpen: true, timeblockId: 'plan-other', duplicateDraft: null };
    const { result } = renderHook(() => useCalendarHandlers());

    result.current.handleTimeblockClick(entry);

    expect(openInspector).toHaveBeenCalledWith('plan-1', 'plan');
    expect(closeInspector).not.toHaveBeenCalled();
  });

  it('1 回のクリックが 2 経路で届いても 1 回だけ処理する', () => {
    const { result } = renderHook(() => useCalendarHandlers());

    // 状態機械の EVENT_CLICK と、その直後に来るカードの onClick
    result.current.handleTimeblockClick(entry);
    result.current.handleTimeblockClick(entry);

    // 2 回処理すると開いて閉じるで打ち消し合い、押しても何も起きなくなる
    expect(openInspector).toHaveBeenCalledTimes(1);
    expect(closeInspector).not.toHaveBeenCalled();
  });

  it('間を空けた 2 回目は畳まない（意図した再クリックは効く）', () => {
    vi.useFakeTimers();
    try {
      // 同じ hook インスタンスのまま時間だけ進める（畳む窓は instance が覚えている）
      const { result, rerender } = renderHook(() => useCalendarHandlers());

      result.current.handleTimeblockClick(entry);
      expect(openInspector).toHaveBeenCalledTimes(1);

      // 開いた状態を反映し、人が押し直す間隔を空ける
      inspectorState.value = { isOpen: true, timeblockId: 'plan-1', duplicateDraft: null };
      rerender();
      vi.advanceTimersByTime(300);
      result.current.handleTimeblockClick(entry);

      expect(closeInspector).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('別のブロックが続けて届いた時は畳まない', () => {
    const { result } = renderHook(() => useCalendarHandlers());

    result.current.handleTimeblockClick(entry);
    result.current.handleTimeblockClick({
      ...entry,
      id: 'plan-2',
    } as unknown as CalendarDisplayEvent);

    expect(openInspector).toHaveBeenCalledTimes(2);
  });

  it('複製の下書き中は閉じない（下書きを黙って捨てない）', () => {
    inspectorState.value = {
      isOpen: true,
      timeblockId: 'plan-1',
      duplicateDraft: { sourceId: 'plan-1', kind: 'plan' },
    };
    const { result } = renderHook(() => useCalendarHandlers());

    result.current.handleTimeblockClick(entry);

    expect(closeInspector).not.toHaveBeenCalled();
    expect(openInspector).toHaveBeenCalledWith('plan-1', 'plan');
  });
});
