import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onChange: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('@/features/calendar/hooks/useCalendarSettings', () => ({
  useCalendarSettings: (selector: (settings: object) => unknown) =>
    selector({ showWeekends: false, hourHeightDensity: 'default' }),
}));

vi.mock('@/lib/hooks/useUpdateUserSettings', () => ({
  useUpdateUserSettings: () => ({ mutate: mocks.mutate }),
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (settings: object) => unknown) =>
    selector({ showWeekNumbers: false }),
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: { getState: () => ({ openSettings: mocks.openSettings }) },
}));

import { ViewSwitcher } from './ViewSwitcher';

describe('ViewSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('7日を選ぶとweekではなく7dayへ切り替える', async () => {
    const user = userEvent.setup();
    render(
      <ViewSwitcher currentView="6day" onChange={mocks.onChange} onSettingsChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'calendar.views.multiday' }));
    const viewOptions = await screen.findAllByRole('menuitem');
    await user.click(viewOptions[7]!);

    expect(mocks.onChange).toHaveBeenCalledWith('7day');
    expect(mocks.onChange).not.toHaveBeenCalledWith('week');
  });

  it('週を選ぶとweekへ切り替える（7日から戻れる）', async () => {
    const user = userEvent.setup();
    render(
      <ViewSwitcher currentView="7day" onChange={mocks.onChange} onSettingsChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'calendar.views.multiday' }));
    await user.click(screen.getByRole('menuitem', { name: /calendar\.views\.week/ }));

    expect(mocks.onChange).toHaveBeenCalledWith('week');
  });

  it('weekは7日ではなく週として表示する', () => {
    render(
      <ViewSwitcher currentView="week" onChange={mocks.onChange} onSettingsChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'calendar.views.week' })).toBeInTheDocument();
  });
});
