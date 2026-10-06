import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activities: [] as Array<{ id: string; name: string }>,
  quickCreate: vi.fn(),
  openActivityCreateModal: vi.fn(),
}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/features/activities', () => ({
  ActivityIcon: () => <span aria-hidden="true" />,
  useActivities: () => ({ data: mocks.activities }),
  useActivitiesMap: () => ({ getActivityById: () => null }),
}));
vi.mock('../../hooks/useActivityModalNavigation', () => ({
  useActivityModalNavigation: () => ({ openActivityCreateModal: mocks.openActivityCreateModal }),
}));
vi.mock('../../hooks/useActivityQuickCreate', () => ({
  useActivityQuickCreate: () => mocks.quickCreate,
}));

import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';

import { ActivityChipRow } from './ActivityChipRow';

describe('ActivityChipRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activities = [{ id: 'activity-1', name: 'Writing' }];
    useActivityDetailStore.getState().close();
  });

  it('activity chip の主操作は引き続き即作成する', async () => {
    const user = userEvent.setup();
    render(<ActivityChipRow />);

    await user.click(screen.getByRole('button', { name: 'Writing' }));

    expect(mocks.quickCreate).toHaveBeenCalledWith({
      activityId: 'activity-1',
      activityName: 'Writing',
    });
  });

  it('モバイルのメニューからアクティビティ詳細を開ける', async () => {
    const user = userEvent.setup();
    render(<ActivityChipRow />);

    await user.click(screen.getByRole('button', { name: 'calendar.filter.activityMenu: Writing' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'calendar.filter.viewActivityDetails' }),
    );

    expect(useActivityDetailStore.getState()).toMatchObject({
      isOpen: true,
      target: { activityId: 'activity-1', name: 'Writing' },
    });
    expect(mocks.quickCreate).not.toHaveBeenCalled();
  });
});
