import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (
    selector: (state: { weekStartsOn: 1; showWeekNumbers: boolean; timezone: string }) => unknown,
  ) => selector({ weekStartsOn: 1, showWeekNumbers: false, timezone: 'Asia/Tokyo' }),
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: {
    use: {
      openTimeblockSearch: () => vi.fn(),
    },
  },
}));

vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/ui/navigation/MobileMonthGrid', () => ({
  MobileMonthGrid: () => <div data-testid="month-grid" />,
}));

vi.mock('@/components/ui/navigation/MobileYearStrip', () => ({
  MobileYearStrip: () => <div data-testid="year-strip" />,
}));

import { MobileCalendarHeader } from './MobileCalendarHeader';

function renderHeader(props: Partial<React.ComponentProps<typeof MobileCalendarHeader>> = {}) {
  return render(
    <MobileCalendarHeader
      currentDate={new Date(2026, 2, 25)}
      onNavigate={vi.fn()}
      onDateSelect={vi.fn()}
      defaultExpanded
      {...props}
    />,
  );
}

/**
 * ミニカレンダー展開パネルの外側タップで閉じる挙動（#2297）
 */
describe('MobileCalendarHeader outside tap to close', () => {
  it('外側をタップするとパネルが閉じる', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { expanded: true });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(document.body);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('パネル内側（月グリッド）をタップしても閉じない', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { expanded: true });
    fireEvent.pointerDown(screen.getByTestId('month-grid'));

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggle ボタン自身のタップでは外側判定による二重発火が起きない（通常のトグルのみ動く）', () => {
    renderHeader();

    const toggle = screen.getByRole('button', { expanded: true });
    // pointerdown だけでは onClick は発火しない（toggle 自身は containerRef 内側）
    fireEvent.pointerDown(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('折りたたみ状態では外側タップを監視しない（リスナー未登録でも例外なし）', () => {
    renderHeader({ defaultExpanded: false });

    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.pointerDown(document.body);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

// CSS で高さだけを閉じても、子孫の操作はフォーカス可能なまま残る。
it('閉じた日付選択は inert にし、展開時だけ操作可能に戻す', () => {
  renderHeader({ defaultExpanded: false });
  const grid = screen.getByTestId('month-grid');
  const toggle = screen.getByRole('button', { expanded: false });
  expect(grid.closest('[inert]')).not.toBeNull();
  fireEvent.click(toggle);
  expect(grid.closest('[inert]')).toBeNull();
  fireEvent.click(toggle);
  expect(grid.closest('[inert]')).not.toBeNull();
});
