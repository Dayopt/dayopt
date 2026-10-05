import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../types/calendar.types';

const mocks = vi.hoisted(() => ({
  deletePlanMutate: vi.fn(),
  deleteRecordMutate: vi.fn(),
  showDeleteUndo: vi.fn(),
  closeInspector: vi.fn(),
}));

vi.mock('@/features/timeblock', () => ({
  useTimeblockWriteMutations: () => ({
    deleteRecord: { mutate: mocks.deleteRecordMutate },
    deletePlan: { mutate: mocks.deletePlanMutate },
  }),
  useTimeblockDeleteUndo: () => mocks.showDeleteUndo,
  useTimeblockInspectorStore: {
    getState: () => ({ closeInspector: mocks.closeInspector }),
  },
}));

vi.mock('@/features/activities', () => ({
  useActivitiesMap: () => ({
    getActivityById: (id: string) =>
      id === 'activity-1'
        ? { id, name: 'Writing', categoryName: 'Work', color: 'blue' }
        : undefined,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn() },
}));

import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';
import { useTimeblockContextActions } from './useTimeblockContextActions';

const classifiedTimeblock = {
  id: 'timeblock-1',
  title: 'Planning',
  kind: 'plan',
  activityId: 'activity-1',
  startDate: new Date(2026, 2, 25, 9),
  actualStartDate: null,
} as unknown as CalendarDisplayEvent;

describe('useTimeblockContextActions - activity details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useActivityDetailStore.getState().close();
  });

  it('opens the selected activity detail without leaving the calendar', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => result.current.handleViewActivityDetails(classifiedTimeblock));

    expect(useActivityDetailStore.getState().target).toEqual({
      activityId: 'activity-1',
      name: 'Writing',
      categoryName: 'Work',
      color: 'blue',
    });
    expect(useActivityDetailStore.getState().isOpen).toBe(true);
    expect(mocks.closeInspector).toHaveBeenCalledOnce();
  });

  it('アクティビティ未設定のtimeblockでは詳細を開かない', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() =>
      result.current.handleViewActivityDetails({ ...classifiedTimeblock, activityId: null }),
    );

    expect(useActivityDetailStore.getState().isOpen).toBe(false);
  });
});

describe('useTimeblockContextActions - 削除', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('右クリックの削除も取り消しを出す（静かに消さない）', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => {
      result.current.handleDeleteTimeblock({
        ...classifiedTimeblock,
        version: '2026-03-25T00:00:00.000Z',
      } as unknown as CalendarDisplayEvent);
    });

    const [input, options] = mocks.deletePlanMutate.mock.calls[0] as [
      { id: string; expectedUpdatedAt: string },
      { onSuccess: (deleted: { id: string; updated_at: string }) => void },
    ];
    expect(input).toEqual({ id: 'timeblock-1', expectedUpdatedAt: '2026-03-25T00:00:00.000Z' });

    // 削除が返した版で戻せるようにする
    options.onSuccess({ id: 'timeblock-1', updated_at: '2026-03-25T00:00:05.000Z' });
    expect(mocks.showDeleteUndo).toHaveBeenCalledWith('plan', {
      id: 'timeblock-1',
      updated_at: '2026-03-25T00:00:05.000Z',
    });
  });

  it('移行済みの記録は削除しない（取り消しも出さない）', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => {
      result.current.handleDeleteTimeblock({
        ...classifiedTimeblock,
        kind: 'record',
        recordSource: 'auto_migrated',
      } as unknown as CalendarDisplayEvent);
    });

    expect(mocks.deleteRecordMutate).not.toHaveBeenCalled();
    expect(mocks.showDeleteUndo).not.toHaveBeenCalled();
  });
});
