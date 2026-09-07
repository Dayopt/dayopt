import type React from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({ isMobile: true }));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mediaMock.isMobile,
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string; weekStartsOn: 1 }) => unknown) =>
    selector({ timezone: 'UTC', weekStartsOn: 1 }),
}));

vi.mock('@/features/calendar/components/views/shared', () => ({
  CalendarDateHeader: ({ header }: { header: React.ReactNode }) => <div>{header}</div>,
  DateDisplay: () => null,
  ScrollableCalendarLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  getDateKey: (date: Date) => date.toISOString().slice(0, 10),
}));

vi.mock('@/features/calendar/components/views/shared/components/CalendarGridContent', () => ({
  CalendarGridContent: ({ laneDisplayMode }: { laneDisplayMode: string }) => (
    <div data-testid="calendar-grid-content" data-lane-display-mode={laneDisplayMode} />
  ),
}));

vi.mock('@/features/calendar/components/views/shared/hooks/useResponsiveHourHeight', () => ({
  useResponsiveHourHeight: () => 60,
}));

vi.mock('@/features/calendar/components/views/WeekView/hooks/useWeekTimeblocks', () => ({
  useWeekTimeblocks: () => ({ entriesByDate: {} }),
}));

import { useCalendarDisplayModeStore } from '@/features/calendar/stores/useCalendarDisplayModeStore';
import { WeekGrid } from './WeekGrid';

const weekDate = new Date('2026-07-13T00:00:00.000Z');

function renderWeekGrid() {
  return render(<WeekGrid weekDates={[weekDate]} events={[]} eventsByDate={{}} todayIndex={0} />);
}

describe('WeekGrid mobile lane display', () => {
  beforeEach(() => {
    mediaMock.isMobile = true;
    useCalendarDisplayModeStore.setState({ mobileWeekDisplayMode: 'recorded' });
  });

  it('モバイルでは記録を既定表示し、予定へ切り替えられる', async () => {
    const user = userEvent.setup();
    renderWeekGrid();

    expect(screen.getByRole('group')).toHaveAccessibleName(
      'calendar.mobile.weekLaneSwitcher.ariaLabel',
    );
    expect(screen.getByTestId('calendar-grid-content')).toHaveAttribute(
      'data-lane-display-mode',
      'record',
    );

    await user.click(screen.getByRole('button', { name: 'calendar.timeblock.preview.plan' }));

    expect(useCalendarDisplayModeStore.getState().mobileWeekDisplayMode).toBe('planned');
    expect(screen.getByTestId('calendar-grid-content')).toHaveAttribute(
      'data-lane-display-mode',
      'plan',
    );
  });

  it('デスクトップでは切替を表示せず両レーンを描画する', () => {
    mediaMock.isMobile = false;
    renderWeekGrid();

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByTestId('calendar-grid-content')).toHaveAttribute(
      'data-lane-display-mode',
      'both',
    );
  });
});
