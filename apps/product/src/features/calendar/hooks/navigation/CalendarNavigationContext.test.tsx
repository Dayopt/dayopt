import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockPathname = '/ja/calendar';
const mockUseMediaQuery = vi.fn(() => false);

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockUseMediaQuery(),
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
    </div>
  );
}

describe('CalendarNavigationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMediaQuery.mockReturnValue(false);
    mockPathname = '/ja/calendar';
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25');
  });

  it('レポートと戻り先の日付が同じでも以前のカレンダー日付を残さない', () => {
    const content = (
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>
    );
    const { rerender } = render(content);
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-25');

    mockPathname = '/ja/report';
    window.history.replaceState(null, '', '/ja/report?date=2026-03-30');
    rerender(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    mockPathname = '/ja/calendar';
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-30');
    rerender(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-30');
  });

  it('resolves view from query on the /calendar URL contract', () => {
    window.history.replaceState(null, '', '/ja/calendar?view=week&date=2026-03-25');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-25');
    expect(screen.getByTestId('view')).toHaveTextContent('week');
  });

  it('/calendar without view defaults to week', () => {
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('week');
  });

  it('resolves multi-day view from query on /calendar', () => {
    window.history.replaceState(null, '', '/ja/calendar?view=3day&date=2026-03-25');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('3day');
  });

  // report タブでは currentDate だけを ?date= から読み、view は無関係のまま
  // （overview.md §6-9 #1）。
  it('resolves currentDate from ?date= on /report without touching view', () => {
    window.history.replaceState(null, '', '/ja/report?date=2026-04-01');
    mockPathname = '/ja/report';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('date')).toHaveTextContent('2026-04-01');
  });

  // URL の書き手はタブ対応（overview.md §5-4-b）: /report 滞在中に日付を変えたら
  // /report の URL を書く。/calendar へタブが飛ばないことを固定する。
  it('writes /report URL (not /calendar) when navigating date while on the report tab', () => {
    window.history.replaceState(null, '', '/ja/report?date=2026-04-01');
    mockPathname = '/ja/report';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move-url' }));

    expect(window.location.pathname + window.location.search).toBe('/ja/report?date=2026-03-30');
  });

  it('keeps internal date changes after navigateToDate', () => {
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    expect(screen.getByTestId('date')).toHaveTextContent('2026-03-29');
  });

  it('writes /calendar URL with the new view when changing view', () => {
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'week' }));
    expect(screen.getByTestId('view')).toHaveTextContent('week');
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/calendar?date=2026-03-25&view=week',
    );
  });

  // モバイルは day-only（#2299）。week は実質 DayView にしか収束せず機能していない
  // 選択肢だったため、changeView('week') はモバイルでは無視される。
  it('モバイルではWeekへ切り替えられない（day-only, #2299）', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'week' }));

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/calendar?date=2026-03-25&view=day',
    );
  });

  it('モバイルのWeek直URLをdayへ戻す（#2299）', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=week');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/calendar?date=2026-03-25&view=day',
    );
  });

  it('モバイルでは未対応の複数日表示へ切り替えない', () => {
    mockUseMediaQuery.mockReturnValue(true);
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '3day' }));

    expect(screen.getByTestId('view')).toHaveTextContent('day');
    expect(window.location.pathname + window.location.search).toBe(
      '/ja/calendar?date=2026-03-25&view=day',
    );
  });

  it('preserves calendar state when the current route is not a calendar page', () => {
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

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

  // /report の URL は view= を持たないため（date のみ）、/report 上での
  // full page reload は Provider を再マウントさせ、view の初期値を URL から
  // 復元する手がかりが無くなる。WorkspaceTabs の「カレンダーへ戻る」リンクは
  // この Provider の viewType を読んで /calendar?view= を組み立てるため、
  // reload 直後に既定値（week）へ落ちると直前まで day だったのに week へ戻って
  // しまう（calendar-navigation.spec.ts の reload 実走で検出、2026-08-19）。
  it('/report での reload（Provider 再マウント）後も直前の calendar view を localStorage から復元する', () => {
    localStorage.clear();
    window.history.replaceState(null, '', '/ja/calendar?date=2026-03-25&view=day');
    mockPathname = '/ja/calendar';

    const { unmount } = render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );
    expect(screen.getByTestId('view')).toHaveTextContent('day');

    // /report へ client-side 遷移（soft nav）。Provider は同一インスタンスのまま。
    mockPathname = '/ja/report';
    window.history.replaceState(null, '', '/ja/report?date=2026-03-25');

    // ここで full page reload が起きたとみなし、Provider を明示的に unmount→remount する
    // （テストでは実ブラウザの reload を再現できないため、この unmount/remount が代替）。
    unmount();

    render(
      <CalendarNavigationProvider>
        <TestConsumer />
      </CalendarNavigationProvider>,
    );

    // /report 自体は view を持たない概念だが、Provider 内部の viewType は
    // 「カレンダーへ戻る」リンクの組み立てに使われるため、reload 前の day を保持する
    expect(screen.getByTestId('view')).toHaveTextContent('day');
  });
});
