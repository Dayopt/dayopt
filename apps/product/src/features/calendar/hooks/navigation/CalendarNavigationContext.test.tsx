import { InitialCalendarDateProvider } from '@/lib/calendar-initial-date';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockPathname = '/ja/';
let mockSearchParams = new URLSearchParams();
const mockUseMediaQuery = vi.fn(() => false);
let mockTimezone = 'UTC';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockUseMediaQuery(),
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => unknown) =>
    selector({ timezone: mockTimezone }),
}));

import { CalendarNavigationProvider, useCalendarNavigation } from './CalendarNavigationContext';

function TestConsumer() {
  const navigation = useCalendarNavigation();

  if (!navigation) {
    throw new Error('Calendar navigation context is missing');
  }

  return (
    <div>
      <span data-testid="date">{navigation.currentDate.toISOString().slice(0, 10)}</span>
      <span data-testid="view">{navigation.viewType}</span>
      <span data-testid="view-ready">{String(navigation.isViewReady)}</span>
      <button
        type="button"
        onClick={() => navigation.navigateToDate(new Date('2026-03-29T12:00:00.000Z'))}
      >
        move
      </button>
      <button type="button" onClick={() => navigation.navigateToDate(new Date('2026-03-30'), true)}>
        move-url
      </button>
      <button type="button" onClick={() => navigation.changeView('week')}>
        week
      </button>
      <button type="button" onClick={() => navigation.changeView('3day')}>
        3day
      </button>
      <button type="button" onClick={() => navigation.navigateRelative('today')}>
        today
      </button>
    </div>
  );
}

describe('CalendarNavigationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMediaQuery.mockReturnValue(false);
    mockTimezone = 'UTC';
    mockPathname = '/ja/';
    mockSearchParams = new URLSearchParams('date=2026-03-25');
    window.history.replaceState(null, '', '/ja/?date=2026-03-25');
  });

  it('settings からホームへ戻る遷移で search が遅れて確定しても ?date= と ?view= に追従する', () => {
    // 同じ element を渡すと React が再 render を省くため、毎回作り直す
    const tree = () => (
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>
    );
    const { rerender } = render(tree());

    mockPathname = '/ja/settings';
    mockSearchParams = new URLSearchParams('date=2026-03-30');
    window.history.replaceState(null, '', '/ja/settings?date=2026-03-30');
    rerender(tree());

    // Next は pathname を先に確定し、その render では window.location.pathname がまだ古い。
    // destination の search が確定するまでは、表示中の日付を維持する。
    mockPathname = '/ja/';
    rerender(tree());
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-25');

    // search が確定した（useSearchParams が更新される）
    mockSearchParams = new URLSearchParams('view=day&date=2026-03-27');
    window.history.replaceState(null, '', '/ja/?view=day&date=2026-03-27');
    rerender(tree());
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-27');
    expect(screen.getByTestId('view')).toHaveTextContent('day');

    // 確定後の calendar 内の URL 書き換え（検索ジャンプ等が途中で書く古い date=）は
    // 「外からの遷移」ではないので拾わない
    mockSearchParams = new URLSearchParams('view=day&date=2026-03-20');
    window.history.replaceState(null, '', '/ja/?view=day&date=2026-03-20');
    rerender(tree());
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-27');
  });

  it('アクティビティ詳細と戻り先の日付が同じでも以前のカレンダー日付を残さない', () => {
    const content = (
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>
    );
    const { rerender } = render(content);
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-25');

    mockPathname = '/ja/settings';
    window.history.replaceState(null, '', '/ja/settings?date=2026-03-30');
    rerender(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    mockPathname = '/ja/';
    window.history.replaceState(null, '', '/ja/?date=2026-03-30');
    rerender(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-30');
  });

  it('resolves view from query on the home URL contract', () => {
    window.history.replaceState(null, '', '/ja/?view=week&date=2026-03-25');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-25');
    expect(screen.getByTestId('view')).toHaveTextContent('week');
  });

  it('home without view defaults to week', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-03-25');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('week');
  });

  it('resolves multi-day view from query on home', () => {
    window.history.replaceState(null, '', '/ja/?view=3day&date=2026-03-25');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('3day');
  });

  it('writes the home URL when navigating to a date', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-04-01&view=day');
    mockSearchParams = new URLSearchParams('date=2026-04-01&view=day');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move-url' }));

    expect(window.location.pathname + window.location.search).toBe('/ja/?date=2026-03-30&view=day');
  });

  it('keeps internal date changes after navigateToDate', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-29');
  });

  it('writes the home URL with the new view when changing view', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'week' }));
    expect(screen.getByTestId('view')).toHaveTextContent('week');
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/?date=2026-03-25&view=week',
    );
  });

  // モバイルは day-only（#2299）。week は実質 DayView にしか収束せず機能していない
  // 選択肢だったため、changeView('week') はモバイルでは無視される。
  it('モバイルではWeekへ切り替えられない（day-only, #2299）', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'week' }));

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe('/ja/?date=2026-03-25&view=day');
  });

  it('モバイルのWeek直URLをdayへ戻す（#2299）', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=week');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe('/ja/?date=2026-03-25&view=day');
  });

  it('モバイルでは未対応の複数日表示へ切り替えない', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '3day' }));

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe('/ja/?date=2026-03-25&view=day');
  });

  it('preserves calendar state when the current route is not a calendar page', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    const { rerender } = render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-29');
    expect(screen.getByTestId('view')).toHaveTextContent('day');

    // Settings ページに遷移してもカレンダー状態は維持される
    mockPathname = '/ja/settings';
    rerender(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-29');
    expect(screen.getByTestId('view')).toHaveTextContent('day');
  });

  it('restores the selected view from the home URL after remount', () => {
    window.history.replaceState(null, '', '/ja/?date=2026-03-25&view=day');
    mockPathname = '/ja/';

    const { unmount } = render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    expect(screen.getByTestId('view')).toHaveTextContent('day');

    // Full page reload を Provider の unmount/remount で再現する。
    unmount();

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view-ready')).toHaveTextContent('true');

    expect(screen.getByTestId('view')).toHaveTextContent('day');
  });
});

describe('CalendarNavigationProvider server initialization', () => {
  it('uses request search params rather than browser location during the first render', () => {
    mockPathname = '/ja/';
    mockSearchParams = new URLSearchParams('date=2026-04-22&view=3day');
    window.history.replaceState(null, '', '/ja/?date=2025-01-01&view=day');
    const html = renderToString(
      <InitialCalendarDateProvider dateKey="2026-09-17">
        <CalendarNavigationProvider>
          <TestConsumer />
        </CalendarNavigationProvider>
      </InitialCalendarDateProvider>,
    );
    expect(html).toContain('2026-04-22');
    expect(html).toContain('3day');
    expect(html).not.toContain('2025-01-01');
  });
  it('uses the supplied request day when date is absent and defaults to week', () => {
    mockPathname = '/ja/';
    mockSearchParams = new URLSearchParams();
    const html = renderToString(
      <InitialCalendarDateProvider dateKey="2026-01-01">
        <CalendarNavigationProvider>
          <TestConsumer />
        </CalendarNavigationProvider>
      </InitialCalendarDateProvider>,
    );
    expect(html).toContain('2026-01-01');
    expect(html).toContain('week');
    expect(html).toContain('data-testid="view-ready">true');
  });
});

it.each([undefined, '2026-04-22'])(
  'timezone未確定の初回だけブラウザー当日へ補正する（date=%s）',
  (date) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T08:00:00Z'));
    mockPathname = '/ja/';
    mockSearchParams = new URLSearchParams(date ? `date=${date}` : '');
    window.history.replaceState(null, '', `/ja/?${mockSearchParams}`);
    try {
      render(
        <InitialCalendarDateProvider dateKey="2026-09-17" needsBrowserDate>
          <CalendarNavigationProvider>
            <TestConsumer />
          </CalendarNavigationProvider>
        </InitialCalendarDateProvider>,
      );
      expect(screen.getByTestId('date')).toHaveTextContent(date ?? '2026-09-18');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('初回モバイルのday切替は補正後の日付をURLへ書く', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T08:00:00Z'));
  mockUseMediaQuery.mockReturnValue(true);
  mockPathname = '/ja/';
  mockSearchParams = new URLSearchParams();
  window.history.replaceState(null, '', '/ja/');
  try {
    render(
      <InitialCalendarDateProvider dateKey="2026-09-17" needsBrowserDate>
        <CalendarNavigationProvider>
          <TestConsumer />
        </CalendarNavigationProvider>
      </InitialCalendarDateProvider>,
    );
    expect(screen.getByTestId('date')).toHaveTextContent('2026-09-18');
    expect(new URLSearchParams(window.location.search).get('date')).toBe('2026-09-18');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('day');
  } finally {
    mockUseMediaQuery.mockReturnValue(false);
    vi.useRealTimers();
  }
});

it('today navigation uses the configured timezone wall date', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T16:00:00.000Z'));
  mockTimezone = 'Asia/Tokyo';
  mockPathname = '/ja/';
  mockSearchParams = new URLSearchParams('date=2026-09-17');
  window.history.replaceState(null, '', '/ja/?date=2026-09-17');
  try {
    render(
      <InitialCalendarDateProvider dateKey="2026-09-17">
        <CalendarNavigationProvider>
          <TestConsumer />
        </CalendarNavigationProvider>
      </InitialCalendarDateProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'today' }));
    expect(screen.getByTestId('date')).toHaveTextContent('2026-09-18');
    expect(new URLSearchParams(window.location.search).get('date')).toBe('2026-09-18');
  } finally {
    mockTimezone = 'UTC';
    vi.useRealTimers();
  }
});
