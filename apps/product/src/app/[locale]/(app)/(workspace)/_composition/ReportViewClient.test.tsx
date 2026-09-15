import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToDate = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
  current: { currentDate: new Date(2026, 8, 2), viewType: 'week' } as {
    currentDate: Date;
    viewType: string;
  } | null,
}));

vi.mock('@/features/calendar', () => ({
  useCalendarNavigation: () =>
    navigationState.current === null ? null : { ...navigationState.current, navigateToDate },
}));

vi.mock('@dayopt/i18n/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const isMobile = vi.hoisted(() => ({ current: false }));

// shell（`BaseLayoutContent`）と同じ幅の判定を見る。`useIsMobile()`（幅 かつ coarse pointer）
// では、狭くしたデスクトップの窓で器と中身が割れる
vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => isMobile.current }));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (p: { timezone: string; weekStartsOn: 0 | 1 | 6 }) => unknown) =>
    selector({ timezone: 'Asia/Tokyo', weekStartsOn: 1 }),
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: { use: { sidebar: () => ({ open: true }), toggleSidebar: () => vi.fn() } },
}));

vi.mock('../../_shell/MobileAccountButton', () => ({
  ConnectedMobileAccountButton: () => <div data-testid="account-button" />,
}));

vi.mock('@/features/review', async () => {
  const actual = await vi.importActual<typeof import('@/features/review')>('@/features/review');
  return {
    ...actual,
    ReportBody: ({ anchorDate, tab }: { anchorDate: string; tab: string }) => (
      <div data-testid="report-body" data-tab={tab}>
        {anchorDate}
      </div>
    ),
    ReportFilterDrawer: () => <div data-testid="filter-drawer" />,
    ReportMobileHeader: ({
      onNavigate,
    }: {
      onNavigate: (direction: 'prev' | 'next' | 'today') => void;
    }) => (
      <div data-testid="mobile-header">
        <button type="button" onClick={() => onNavigate('prev')}>
          prev
        </button>
      </div>
    ),
    ReportHeader: ({
      periodStart,
      periodEnd,
      onNavigate,
      onGranularityChange,
    }: {
      periodStart: Date;
      periodEnd: Date;
      onNavigate: (direction: 'prev' | 'next' | 'today') => void;
      onGranularityChange: (granularity: 'week' | 'month' | 'year') => void;
    }) => (
      <div data-testid="desktop-header">
        <span data-testid="period">
          {periodStart.toDateString()}–{periodEnd.toDateString()}
        </span>
        <button type="button" onClick={() => onNavigate('prev')}>
          prev
        </button>
        <button type="button" onClick={() => onNavigate('next')}>
          next
        </button>
        <button type="button" onClick={() => onGranularityChange('month')}>
          month
        </button>
      </div>
    ),
  };
});

import { ReportViewClient } from './ReportViewClient';

describe('ReportViewClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.current = { currentDate: new Date(2026, 8, 2), viewType: 'week' };
    isMobile.current = false;
  });

  it('表示中の日付を CalendarNavigationContext から取る', () => {
    render(<ReportViewClient granularity="week" tab="usage" />);

    // 2026-09-02（水）を含む週は 08-31（月）〜 09-06（日）
    expect(screen.getByTestId('report-body')).toHaveTextContent('2026-09-02');
    expect(screen.getByTestId('period')).toHaveTextContent('Mon Aug 31 2026');
  });

  /**
   * これが本 test の主眼。`?date=` を server component の prop で受けると、
   * `navigateToDate` は `history.replaceState` を書くだけで RSC を再描画しないため
   * 期間移動が画面に反映されなくなる（#2577 のクロスレビュー P1）。
   */
  it('Context の日付が変わると表示中の期間も変わる', () => {
    const { rerender } = render(<ReportViewClient granularity="week" tab="usage" />);
    expect(screen.getByTestId('period')).toHaveTextContent('Mon Aug 31 2026');

    navigationState.current = { currentDate: new Date(2026, 7, 26), viewType: 'week' };
    rerender(<ReportViewClient granularity="week" tab="usage" />);

    // 前週（08-24〜08-30）へ移る
    expect(screen.getByTestId('period')).toHaveTextContent('Mon Aug 24 2026');
    expect(screen.getByTestId('report-body')).toHaveTextContent('2026-08-26');
  });

  it('前後の移動が粒度ぶんだけ Context を進める', async () => {
    const user = userEvent.setup();
    render(<ReportViewClient granularity="week" tab="usage" />);

    await user.click(screen.getByRole('button', { name: 'prev' }));
    expect(navigateToDate).toHaveBeenCalledWith(new Date(2026, 7, 26), true);

    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(navigateToDate).toHaveBeenCalledWith(new Date(2026, 8, 9), true);
  });

  it('月粒度では 1 か月ずつ動く', async () => {
    const user = userEvent.setup();
    render(<ReportViewClient granularity="month" tab="usage" />);

    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(navigateToDate).toHaveBeenCalledWith(new Date(2026, 9, 2), true);
  });

  it('粒度切替は URL の range を書き換える（日付は保つ）', async () => {
    const user = userEvent.setup();
    render(<ReportViewClient granularity="week" tab="usage" />);

    await user.click(screen.getByRole('button', { name: 'month' }));

    expect(routerPush).toHaveBeenCalledWith('/report?date=2026-09-02&range=month');
    // 日付の移動は伴わない
    expect(navigateToDate).not.toHaveBeenCalled();
  });

  describe('タブ', () => {
    it('3 つのタブをヘッダーの下の行に出し、page から渡された面を描く', () => {
      render(<ReportViewClient granularity="week" tab="diff" />);

      const tabs = screen.getAllByRole('tab');
      // タブはヘッダーの中ではなく、下の 2 行目に置く
      expect(screen.getByTestId('desktop-header')).not.toContainElement(tabs[0] ?? null);
      expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
        'usage',
        'diff',
        'reflect',
      ]);
      expect(screen.getByRole('tab', { name: 'diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('report-body')).toHaveAttribute('data-tab', 'diff');
    });

    /**
     * 押した瞬間に面を切り替え、URL は履歴に積まずに書き換える。期間（date / range）は保つ。
     * 戻るボタンがタブの往復で埋まると `/report` から前の画面へ戻れなくなる。
     */
    it('タブを押すと即座に面が変わり、URL を replace で書き換える', async () => {
      const user = userEvent.setup();
      render(<ReportViewClient granularity="month" tab="usage" />);

      await user.click(screen.getByRole('tab', { name: 'reflect' }));

      expect(screen.getByTestId('report-body')).toHaveAttribute('data-tab', 'reflect');
      expect(routerReplace).toHaveBeenCalledWith(
        '/report?date=2026-09-02&range=month&tab=reflect',
        {
          scroll: false,
        },
      );
      expect(routerPush).not.toHaveBeenCalled();
      expect(navigateToDate).not.toHaveBeenCalled();
    });

    it('粒度を変えても選んでいるタブを保つ', async () => {
      const user = userEvent.setup();
      render(<ReportViewClient granularity="week" tab="diff" />);

      await user.click(screen.getByRole('button', { name: 'month' }));

      expect(routerPush).toHaveBeenCalledWith('/report?date=2026-09-02&range=month&tab=diff');
    });

    it('戻る操作などで page の tab が変わったら、表示もそちらへ寄せる', () => {
      const { rerender } = render(<ReportViewClient granularity="week" tab="usage" />);

      rerender(<ReportViewClient granularity="week" tab="reflect" />);

      expect(screen.getByTestId('report-body')).toHaveAttribute('data-tab', 'reflect');
    });
  });

  it('Provider が無くても落ちない', () => {
    navigationState.current = null;

    expect(() => render(<ReportViewClient granularity="week" tab="usage" />)).not.toThrow();
  });
});

describe('ReportViewClient（モバイル）', () => {
  /** 縦スクロールの本体。スワイプはここに掛かる。 */
  function scrollArea() {
    const area = screen.getByTestId('report-body').parentElement;
    if (area === null) throw new Error('scroll area not found');
    return area;
  }

  function swipe(from: number, to: number, dy = 0) {
    const area = scrollArea();
    fireEvent.touchStart(area, { touches: [{ clientX: from, clientY: 100 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: to, clientY: 100 + dy }] });
    fireEvent.touchEnd(area, { touches: [{ clientX: to, clientY: 100 + dy }] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.current = { currentDate: new Date(2026, 8, 2), viewType: 'week' };
    isMobile.current = true;
  });

  /**
   * 仕様 §8。サイドバーを持たない面なので、フィルタはタブ行の右端のボタン（Drawer）が担う。
   * 粒度切替は出さない（狭い面では期間ラベルと `‹ ›` が潰れる）。タブはデスクトップと同じく出す。
   */
  it('モバイルではタブ行にフィルタのボタンを出し、粒度切替は出さない', () => {
    render(<ReportViewClient granularity="week" tab="usage" />);

    expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    // タブとフィルタは同じ行（3 段目を作らない）
    expect(screen.getByTestId('filter-drawer').parentElement).toContainElement(
      screen.getAllByRole('tab')[0] ?? null,
    );
    expect(screen.queryByRole('button', { name: 'month' })).toBeNull();
  });

  /**
   * ただし粒度そのものは URL に従う。デスクトップで月を見て共有したリンクを
   * スマホで開いた時に、勝手に週へ丸めない（2026-09-05 User 裁可）。
   */
  it('URL の粒度を尊重する（月のまま描き、スワイプも月で動く）', () => {
    render(<ReportViewClient granularity="month" tab="usage" />);

    expect(screen.getByTestId('report-body')).toHaveTextContent('2026-09-02');

    swipe(240, 160);

    expect(navigateToDate).toHaveBeenCalledWith(new Date(2026, 9, 2), true);
  });

  it('左スワイプで次の期間、右スワイプで前の期間へ', () => {
    render(<ReportViewClient granularity="week" tab="usage" />);

    swipe(240, 160);
    expect(navigateToDate).toHaveBeenLastCalledWith(new Date(2026, 8, 9), true);

    swipe(160, 240);
    expect(navigateToDate).toHaveBeenLastCalledWith(new Date(2026, 7, 26), true);
  });

  /** しきい値は 55px。章をなぞる程度の指で数字が黙って入れ替わらない。 */
  it('55px 未満の指では動かない', () => {
    render(<ReportViewClient granularity="week" tab="usage" />);

    swipe(200, 150);

    expect(navigateToDate).not.toHaveBeenCalled();
  });

  /** 縦が水平の 1.4 倍を超えたらスクロール扱い（誤発火しない）。 */
  it('縦スクロールでは発火しない', () => {
    render(<ReportViewClient granularity="week" tab="usage" />);

    swipe(240, 160, 200);

    expect(navigateToDate).not.toHaveBeenCalled();
  });

  /** デスクトップでは指の代わりにマウスが動くので、そもそも掛けない。 */
  it('デスクトップではスワイプが無効', () => {
    isMobile.current = false;
    render(<ReportViewClient granularity="week" tab="usage" />);

    swipe(240, 160);

    expect(navigateToDate).not.toHaveBeenCalled();
  });
});
