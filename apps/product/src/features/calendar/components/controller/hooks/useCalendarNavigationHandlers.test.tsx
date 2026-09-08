import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCalendarNavigationHandlers } from './useCalendarNavigationHandlers';

vi.mock('@/lib/hooks/useUpdateUserSettings', () => ({
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn() },
}));

describe('useCalendarNavigationHandlers', () => {
  it('週末非表示のmulti-day navigationへ営業日設定を渡す', () => {
    const navigateRelative = vi.fn();
    const { result } = renderHook(() =>
      useCalendarNavigationHandlers({
        viewType: '7day',
        currentDate: new Date('2026-01-15T12:00:00'),
        showWeekends: false,
        navigateRelative,
        navigateToDate: vi.fn(),
        changeView: vi.fn(),
      }),
    );

    act(() => result.current.handleNavigate('next'));

    expect(navigateRelative).toHaveBeenCalledWith('next', false);
  });
});

it('日付選択は表示だけでなくURLも更新する', () => {
  const navigateToDate = vi.fn();
  const { result } = renderHook(() =>
    useCalendarNavigationHandlers({
      viewType: 'day',
      currentDate: new Date(2026, 8, 8),
      showWeekends: true,
      navigateRelative: vi.fn(),
      navigateToDate,
      changeView: vi.fn(),
    }),
  );
  const selectedDate = new Date(2026, 8, 7);
  act(() => result.current.handleDateSelect(selectedDate));
  expect(navigateToDate).toHaveBeenCalledWith(selectedDate, true);
});
