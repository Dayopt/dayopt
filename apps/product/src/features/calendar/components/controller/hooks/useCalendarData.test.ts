import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  timezone: 'UTC',
  plans: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; weekStartsOn: 1 }) => unknown) =>
    selector({ timezone: state.timezone, weekStartsOn: 1 }),
}));

vi.mock('@/features/activities', () => ({
  useActivities: () => ({ data: [] }),
  useArchivedActivities: () => ({ data: [] }),
}));

vi.mock('@/features/external-calendar', () => ({
  useExternalCalendarEvents: () => ({ events: [] }),
}));

vi.mock('@/lib/trpc', () => {
  const query = (data: () => unknown) => ({
    useQuery: () => ({
      data: data(),
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
  });
  return {
    api: {
      plans: { list: query(() => state.plans) },
      records: { list: query(() => []) },
      useUtils: () => ({
        plans: { list: { prefetch: vi.fn() } },
        records: { list: { prefetch: vi.fn() } },
        externalCalendar: { listEvents: { prefetch: vi.fn() } },
      }),
    },
  };
});

import { useCalendarData } from './useCalendarData';

function plan(id: string, startAt: string, endAt: string) {
  return {
    id,
    title: id,
    note: null,
    start_at: startAt,
    end_at: endAt,
    activity_id: null,
    updated_at: '2026-09-01T00:00:00.000000Z',
  };
}

const originalTz = process.env.TZ;

describe('useCalendarData の表示範囲フィルタ', () => {
  beforeEach(() => {
    state.plans = [];
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('OSより東の設定timezoneでも、表示日の前日の予定を含めない', () => {
    process.env.TZ = 'Asia/Tokyo';
    state.timezone = 'America/New_York';
    state.plans = [
      // NY 9/28 12:00–13:00
      plan('ny-monday', '2026-09-28T16:00:00Z', '2026-09-28T17:00:00Z'),
      // NY 9/29 12:00–13:00
      plan('ny-tuesday', '2026-09-29T16:00:00Z', '2026-09-29T17:00:00Z'),
    ];

    const { result } = renderHook(() =>
      useCalendarData({
        viewType: 'day',
        currentDate: new Date(2026, 8, 29, 12),
        showWeekends: true,
      }),
    );

    expect(result.current.filteredEvents.map((event) => event.id)).toEqual(['ny-tuesday']);
  });

  it('OSと設定timezoneの差が24時間でも、表示日の予定を落とさない', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    state.timezone = 'Pacific/Honolulu';
    state.plans = [
      // Honolulu 9/29 10:00–11:00
      plan('honolulu-tuesday', '2026-09-29T20:00:00Z', '2026-09-29T21:00:00Z'),
    ];

    const { result } = renderHook(() =>
      useCalendarData({
        viewType: 'day',
        currentDate: new Date(2026, 8, 29, 12),
        showWeekends: true,
      }),
    );

    expect(result.current.filteredEvents.map((event) => event.id)).toEqual(['honolulu-tuesday']);
  });
});
