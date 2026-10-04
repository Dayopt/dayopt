import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.hoisted(() => vi.fn(() => '/calendar'));
const navigationMock = vi.hoisted(() =>
  vi.fn((): { currentDate: Date; viewType: 'week' | 'day'; isViewReady?: boolean } | null => ({
    currentDate: new Date(2026, 2, 25),
    viewType: 'week',
  })),
);

vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: pathnameMock,
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/features/calendar', () => ({
  resolveWorkspaceTab: (pathname: string) =>
    pathname === '/calendar' ? 'calendar' : pathname === '/report' ? 'report' : 'other',
  formatCalendarDateParam: () => '2026-03-25',
  useCalendarNavigation: () => navigationMock(),
}));

import { WorkspaceTabs } from './WorkspaceTabs';

describe('WorkspaceTabs', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/calendar');
    navigationMock.mockReturnValue({ currentDate: new Date(2026, 2, 25), viewType: 'week' });
  });

  it('marks the calendar tab as selected on /calendar', () => {
    render(<WorkspaceTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('marks the report tab as selected on /report', () => {
    pathnameMock.mockReturnValue('/report');

    render(<WorkspaceTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('carries the current date and view into the calendar tab href', () => {
    render(<WorkspaceTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('href', '/calendar?view=week&date=2026-03-25');
  });

  it('復元前はカレンダーへ遷移できず、復元後は保存済みビューへのリンクになる', () => {
    pathnameMock.mockReturnValue('/report');
    navigationMock.mockReturnValue({
      currentDate: new Date(2026, 2, 25),
      viewType: 'week',
      isViewReady: false,
    });
    const { rerender } = render(<WorkspaceTabs />);
    const calendarTab = screen.getAllByRole('tab')[0];
    expect(calendarTab).toBeDisabled();
    expect(calendarTab).not.toHaveAttribute('href');

    navigationMock.mockReturnValue({
      currentDate: new Date(2026, 2, 25),
      viewType: 'day',
      isViewReady: true,
    });
    rerender(<WorkspaceTabs />);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute(
      'href',
      '/calendar?view=day&date=2026-03-25',
    );
  });

  it('carries the current date into the report tab href (no view)', () => {
    render(<WorkspaceTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[1]).toHaveAttribute('href', '/report?date=2026-03-25');
  });

  it('omits date from hrefs when navigation context is unavailable', () => {
    navigationMock.mockReturnValue(null);

    render(<WorkspaceTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('href', '/calendar?view=week');
    expect(tabs[1]).toHaveAttribute('href', '/report');
  });
});
