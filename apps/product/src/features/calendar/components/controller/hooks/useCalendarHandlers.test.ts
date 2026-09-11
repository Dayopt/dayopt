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
