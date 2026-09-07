import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../types/calendar.types';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
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
    deleteRecord: { mutate: vi.fn() },
    deletePlan: { mutate: vi.fn() },
  }),
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
