import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.hoisted(() => vi.fn(() => '/'));
const navigationMock = vi.hoisted(() =>
  vi.fn((): { currentDate: Date } | null => ({ currentDate: new Date(2026, 2, 25) })),
);

vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: pathnameMock,
}));

vi.mock('@/features/calendar', () => ({
  isCalendarViewPath: (pathname: string) => pathname === '/',
  useCalendarNavigation: () => navigationMock(),
}));

vi.mock('@/components/ui/inputs/mini-calendar', () => ({
  MiniCalendar: () => <div data-testid="mini-calendar" />,
}));

import { SidebarPinnedContent } from './SidebarPinnedContent';

describe('SidebarPinnedContent', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/');
    navigationMock.mockReturnValue({ currentDate: new Date(2026, 2, 25) });
  });

  it('shows MiniCalendar on the home calendar', () => {
    render(<SidebarPinnedContent />);
    expect(screen.getByTestId('mini-calendar')).toBeInTheDocument();
  });

  it('renders nothing on workspace-external paths (e.g. /settings)', () => {
    pathnameMock.mockReturnValue('/settings');
    const { container } = render(<SidebarPinnedContent />);
    expect(container).toBeEmptyDOMElement();
  });
});
