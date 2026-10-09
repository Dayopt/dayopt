import type React from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDateKey } from '@/lib/date';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

const mediaMock = vi.hoisted(() => ({ isMobile: true, timezone: 'UTC' }));
const groupingMock = vi.hoisted(() => ({ byDate: {} as Record<string, CalendarDisplayEvent[]> }));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mediaMock.isMobile,
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string; weekStartsOn: 1 }) => unknown) =>
    selector({ timezone: mediaMock.timezone, weekStartsOn: 1 }),
}));

vi.mock('@/features/calendar/components/views/shared', () => ({
  CalendarDateHeader: ({ header }: { header: React.ReactNode }) => <div>{header}</div>,
  DateDisplay: () => null,
  ScrollableCalendarLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  getDateKey: (date: Date, timezone?: string) => getDateKey(date, timezone),
}));

vi.mock('@/features/calendar/components/views/shared/components/CalendarGridContent', () => ({
  CalendarGridContent: ({
    laneDisplayMode,
    timeblocks,
    dayIndex,
  }: {
    laneDisplayMode: string;
    timeblocks: CalendarDisplayEvent[];
    dayIndex: number;
  }) => (
    <div
      data-testid="calendar-grid-content"
      data-lane-display-mode={laneDisplayMode}
      data-day-index={dayIndex}
    >
      {timeblocks.map((timeblock) => (
        <span key={timeblock.id}>{timeblock.title}</span>
      ))}
    </div>
  ),
}));

vi.mock('@/features/calendar/components/views/shared/hooks/useResponsiveHourHeight', () => ({
  useResponsiveHourHeight: () => 60,
}));

vi.mock('@/features/calendar/components/views/WeekView/hooks/useWeekTimeblocks', () => ({
  useWeekTimeblocks: () => ({ timeblocksByDate: groupingMock.byDate }),
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
    mediaMock.timezone = 'UTC';
    groupingMock.byDate = {};
    useCalendarDisplayModeStore.setState({ mobileWeekDisplayMode: 'recorded' });
  });

  it('表示日付のキーで火曜日の予定を火曜日のグリッドへ渡す', () => {
    mediaMock.timezone = 'America/New_York';
    const plan: CalendarDisplayEvent = {
      id: 'tuesday',
      title: 'Tuesday plan',
      startDate: new Date('2026-09-29T16:14:00Z'),
      endDate: new Date('2026-09-29T17:14:00Z'),
      displayStartDate: new Date(2026, 8, 29, 12, 14),
      displayEndDate: new Date(2026, 8, 29, 13, 14),
      color: 'blue',
      duration: 60,
      isMultiDay: false,
      version: '2026-09-29T03:16:40.057861Z',
      kind: 'plan',
    };
    groupingMock.byDate = { '2026-09-29': [plan] };
    const weekDates = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 28 + index));
    render(<WeekGrid weekDates={weekDates} events={[plan]} eventsByDate={{}} todayIndex={0} />);

    expect(screen.getByText('Tuesday plan').closest('[data-day-index]')).toHaveAttribute(
      'data-day-index',
      '1',
    );
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
