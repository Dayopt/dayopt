import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimeblockSearchResult } from '@/features/calendar';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: routerPush }),
}));

import { useTimeblockSearchResultNavigation } from './useTimeblockSearchResultNavigation';

const RESULT: TimeblockSearchResult = {
  kind: 'record',
  id: 'record-1',
  note: 'Search result',
  activityId: 'activity-1',
  startAt: '2026-07-14T01:30:00.000Z',
  endAt: '2026-07-14T02:30:00.000Z',
};

describe('useTimeblockSearchResultNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/ja/calendar?date=2026-08-09&view=day');
  });

  it('対象日の描画とoverlay終了後にだけ検索結果URLを1回公開する', async () => {
    const navigateToDate = vi.fn();
    const changeView = vi.fn();
    const pushState = vi.spyOn(window.history, 'pushState');
    const initialDate = new Date(2026, 7, 9, 12);

    const { result, rerender } = renderHook(
      ({ currentDate, searchOpen, inspectorOpen }) =>
        useTimeblockSearchResultNavigation({
          calendarNavigation: { currentDate, viewType: 'day', navigateToDate, changeView },
          locale: 'ja',
          timezone: 'Asia/Tokyo',
          timeblockSearchOpen: searchOpen,
          isInspectorOpen: inspectorOpen,
        }),
      {
        initialProps: {
          currentDate: initialDate,
          searchOpen: true,
          inspectorOpen: false,
        },
      },
    );

    act(() => result.current(RESULT));

    expect(navigateToDate).toHaveBeenCalledOnce();
    expect(changeView).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    const targetDate = navigateToDate.mock.calls[0]![0] as Date;

    rerender({ currentDate: initialDate, searchOpen: false, inspectorOpen: false });
    expect(pushState).not.toHaveBeenCalled();

    rerender({ currentDate: targetDate, searchOpen: false, inspectorOpen: true });
    expect(pushState).not.toHaveBeenCalled();

    rerender({ currentDate: targetDate, searchOpen: false, inspectorOpen: false });
    await waitFor(() => expect(pushState).toHaveBeenCalledOnce());
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/calendar?date=2026-07-14&view=day&timeblock=record%3Arecord-1',
    );

    rerender({ currentDate: targetDate, searchOpen: false, inspectorOpen: false });
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('CalendarNavigationProvider外ではrouter navigationへfallbackする', () => {
    const { result } = renderHook(() =>
      useTimeblockSearchResultNavigation({
        calendarNavigation: null,
        locale: 'ja',
        timezone: 'Asia/Tokyo',
        timeblockSearchOpen: false,
        isInspectorOpen: false,
      }),
    );

    act(() => result.current(RESULT));

    expect(routerPush).toHaveBeenCalledWith(
      '/ja/calendar?date=2026-07-14&view=day&timeblock=record%3Arecord-1',
    );
  });

  it('対象日を既に表示中なら不要な日付更新をせず同じ結果を開き直す', async () => {
    const navigateToDate = vi.fn();
    const changeView = vi.fn();
    const currentDate = new Date(2026, 6, 14, 12);

    const { result, rerender } = renderHook(
      ({ searchOpen }) =>
        useTimeblockSearchResultNavigation({
          calendarNavigation: { currentDate, viewType: 'day', navigateToDate, changeView },
          locale: 'ja',
          timezone: 'Asia/Tokyo',
          timeblockSearchOpen: searchOpen,
          isInspectorOpen: false,
        }),
      { initialProps: { searchOpen: true } },
    );

    act(() => result.current(RESULT));
    expect(navigateToDate).not.toHaveBeenCalled();

    rerender({ searchOpen: false });
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        '/ja/calendar?date=2026-07-14&view=day&timeblock=record%3Arecord-1',
      ),
    );
  });

  // buildTimeblockSearchResultPath は view=day を URL へ書くが、raw pushState は
  // pathname を変えないため CalendarNavigationContext の useMemo（[pathname] 依存）
  // には拾われない（block-search.spec.ts の実走で検出、2026-08-19）。
  // changeView() を明示的に呼んで view state を揃えることを固定する。
  it('week表示から検索結果を開くとview stateをdayへ明示的に揃える', () => {
    const navigateToDate = vi.fn();
    const changeView = vi.fn();
    const currentDate = new Date(2026, 6, 14, 12);

    const { result } = renderHook(() =>
      useTimeblockSearchResultNavigation({
        calendarNavigation: { currentDate, viewType: 'week', navigateToDate, changeView },
        locale: 'ja',
        timezone: 'Asia/Tokyo',
        timeblockSearchOpen: true,
        isInspectorOpen: false,
      }),
    );

    act(() => result.current(RESULT));

    expect(changeView).toHaveBeenCalledExactlyOnceWith('day');
  });
});
