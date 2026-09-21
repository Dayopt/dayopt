import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: (namespace?: string) => {
    const catalogue: Record<string, string> = {
      'report.mobile.periodFormat.weekDay': 'M月d日',
      'report.mobile.periodFormat.weekDayShort': 'd日',
      'report.mobile.periodFormat.weekRange': '{start}〜{end}',
      'report.mobile.periodFormat.month': 'M月',
      'report.mobile.periodFormat.year': "yyyy'年'",
      'report.nav.current.week': 'report.nav.current.week',
    };
    const translate = (key: string) => {
      const full = namespace ? `${namespace}.${key}` : key;
      return catalogue[full] ?? full;
    };
    // 書式キーは `raw()` で引く（`{start}〜{end}` を `t()` に通すと ICU 解釈で壊れる）
    translate.raw = translate;
    return translate;
  },
}));

// 月グリッドと年ストリップは共有層の実体を持つ。ここで見たいのは器の開閉と受け渡し
vi.mock('@/components/ui/navigation/MobileMonthGrid', () => ({
  MobileMonthGrid: ({ displayRange }: { displayRange?: { start: Date; end: Date } }) => (
    <div
      data-testid="month-grid"
      data-range={
        displayRange
          ? `${displayRange.start.toDateString()}/${displayRange.end.toDateString()}`
          : 'none'
      }
    />
  ),
}));
vi.mock('@/components/ui/navigation/MobileYearStrip', () => ({
  MobileYearStrip: () => <div data-testid="year-strip" />,
}));

import { ReportMobileHeader } from './ReportMobileHeader';

const BASE_PROPS = {
  periodStart: new Date(2026, 7, 31),
  periodEnd: new Date(2026, 8, 6),
  granularity: 'week' as const,
  todayDirection: 'current' as const,
  onNavigate: () => {},
};

describe('ReportMobileHeader', () => {
  /** カレンダーのモバイルヘッダーに合わせ、週と月は年を出さない（2026-09-07 User 指示）。 */
  it('週と月のラベルに年を出さない', () => {
    const { rerender } = render(<ReportMobileHeader {...BASE_PROPS} onDateSelect={() => {}} />);
    expect(screen.getByText('8月31日〜9月6日')).toBeInTheDocument();

    rerender(
      <ReportMobileHeader
        {...BASE_PROPS}
        granularity="month"
        periodStart={new Date(2026, 8, 1)}
        periodEnd={new Date(2026, 8, 30)}
        onDateSelect={() => {}}
      />,
    );
    expect(screen.getByText('9月')).toBeInTheDocument();
  });

  /** 年粒度だけは年が対象そのものなので残す。 */
  it('年粒度は年を出す', () => {
    render(
      <ReportMobileHeader
        {...BASE_PROPS}
        granularity="year"
        periodStart={new Date(2026, 0, 1)}
        periodEnd={new Date(2026, 11, 31)}
        onDateSelect={() => {}}
      />,
    );
    expect(screen.getByText('2026年')).toBeInTheDocument();
  });

  it('ラベルを押すとミニカレンダーが開き、見ている期間を範囲で渡す', async () => {
    const user = userEvent.setup();
    render(<ReportMobileHeader {...BASE_PROPS} onDateSelect={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'report.mobile.openMiniCalendar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'report.mobile.closeMiniCalendar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('month-grid')).toHaveAttribute(
      'data-range',
      `${BASE_PROPS.periodStart.toDateString()}/${BASE_PROPS.periodEnd.toDateString()}`,
    );
    expect(screen.getByTestId('year-strip')).toBeInTheDocument();
  });

  /** 押しても何も起きない chevron を残さない。 */
  it('onDateSelect が無ければミニカレンダーごと出さない', () => {
    render(<ReportMobileHeader {...BASE_PROPS} />);

    expect(
      screen.queryByRole('button', { name: 'report.mobile.openMiniCalendar' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('month-grid')).not.toBeInTheDocument();
    expect(screen.getByText('8月31日〜9月6日')).toBeInTheDocument();
  });

  /**
   * `‹ 今週へ ›` はモバイルに置かない（2026-09-07 User 指示）。期間の移動は本文の
   * 左右スワイプが担い、ヘッダーに残すのは「今日へ」のアイコン 1 つだけ。
   */
  it('ナビゲーションバーを置かず、今日へはアイコン 1 つにする', () => {
    render(<ReportMobileHeader {...BASE_PROPS} todayDirection="past" onDateSelect={() => {}} />);

    expect(screen.queryByRole('button', { name: 'common.previous' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'report.nav.current.week' })).toBeInTheDocument();
  });

  /** 今日を含む期間では、押しても何も起きないボタンを残さない。 */
  it('今日を含む期間では「今日へ」を出さない', () => {
    render(<ReportMobileHeader {...BASE_PROPS} onDateSelect={() => {}} />);

    expect(
      screen.queryByRole('button', { name: 'report.nav.current.week' }),
    ).not.toBeInTheDocument();
  });

  /** 粒度はヘッダーではなくミニカレンダーの中（2026-09-07 User 裁可）。 */
  it('粒度切替をヘッダーではなくミニカレンダーの中に置く', async () => {
    const user = userEvent.setup();
    render(
      <ReportMobileHeader {...BASE_PROPS} onDateSelect={() => {}} onGranularityChange={() => {}} />,
    );

    const group = screen.getByRole('tablist', { name: 'report.granularity.ariaLabel' });
    // ヘッダー行の外（展開パネルの中）にいる
    expect(group.closest('header')).toBeNull();
    // 月グリッドより前（パネルの上端）に置く
    expect(
      group.compareDocumentPosition(screen.getByTestId('month-grid')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 畳んでいる間はフォーカスを入れない（パネルは DOM に残るため inert で塞ぐ）
    const panel = group.closest('[inert]');
    expect(panel).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'report.mobile.openMiniCalendar' }));
    expect(group.closest('[inert]')).toBeNull();
  });

  it('同じ月に収まる週は月を 1 回だけ出す', () => {
    render(
      <ReportMobileHeader
        {...BASE_PROPS}
        periodStart={new Date(2026, 8, 14)}
        periodEnd={new Date(2026, 8, 20)}
        onDateSelect={() => {}}
      />,
    );

    expect(screen.getByText('9月14日〜20日')).toBeInTheDocument();
  });
});
