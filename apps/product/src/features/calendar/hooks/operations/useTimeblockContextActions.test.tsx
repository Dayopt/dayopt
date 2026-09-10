import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../types/calendar.types';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  deletePlanMutate: vi.fn(),
  deleteRecordMutate: vi.fn(),
  showDeleteUndo: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/features/timeblock', () => ({
  useTimeblockWriteMutations: () => ({
    deleteRecord: { mutate: mocks.deleteRecordMutate },
    deletePlan: { mutate: mocks.deletePlanMutate },
  }),
  useTimeblockDeleteUndo: () => mocks.showDeleteUndo,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn() },
}));

import { useTimeblockContextActions } from './useTimeblockContextActions';

const classifiedEntry = {
  id: 'entry-1',
  kind: 'plan',
  activityId: 'activity-1',
  startDate: new Date(2026, 2, 25, 9),
  actualStartDate: null,
} as unknown as CalendarDisplayEvent;

describe('useTimeblockContextActions - Review navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('/report へ遷移する（カレンダー内パネルは廃止済み、#2181 Step 4）', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => result.current.handleViewStats(classifiedEntry));

    expect(mocks.push).toHaveBeenCalledWith('/ja/report?date=2026-03-25');
  });

  it('tagなしentryではReviewを開かない', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => result.current.handleViewStats({ ...classifiedEntry, activityId: null }));

    expect(mocks.push).not.toHaveBeenCalled();
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
        ...classifiedEntry,
        version: '2026-03-25T00:00:00.000Z',
      } as unknown as CalendarDisplayEvent);
    });

    const [input, options] = mocks.deletePlanMutate.mock.calls[0] as [
      { id: string; expectedUpdatedAt: string },
      { onSuccess: (deleted: { id: string; updated_at: string }) => void },
    ];
    expect(input).toEqual({ id: 'entry-1', expectedUpdatedAt: '2026-03-25T00:00:00.000Z' });

    // 削除が返した版で戻せるようにする
    options.onSuccess({ id: 'entry-1', updated_at: '2026-03-25T00:00:05.000Z' });
    expect(mocks.showDeleteUndo).toHaveBeenCalledWith('plan', {
      id: 'entry-1',
      updated_at: '2026-03-25T00:00:05.000Z',
    });
  });

  it('移行済みの記録は削除しない（取り消しも出さない）', () => {
    const { result } = renderHook(() => useTimeblockContextActions());

    act(() => {
      result.current.handleDeleteTimeblock({
        ...classifiedEntry,
        kind: 'record',
        recordSource: 'auto_migrated',
      } as unknown as CalendarDisplayEvent);
    });

    expect(mocks.deleteRecordMutate).not.toHaveBeenCalled();
    expect(mocks.showDeleteUndo).not.toHaveBeenCalled();
  });
});
