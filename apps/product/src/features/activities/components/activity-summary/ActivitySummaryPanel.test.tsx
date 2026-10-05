import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

import { ActivitySummaryPanel } from './ActivitySummaryPanel';

it('shows record date and duration without the legacy activity title', () => {
  render(
    <ActivitySummaryPanel
      target={{ activityId: 'activity-1', name: 'Current activity name' }}
      data={{
        startDate: '2026-03-01',
        endDate: '2026-03-31',
        recordedMinutes: 30,
        medianBoxMinutes: null,
        totalRecordCount: 1,
        records: [
          {
            id: 'record-1',
            title: 'Legacy activity name',
            startAt: '2026-03-15T10:00:00.000Z',
            endAt: '2026-03-15T10:30:00.000Z',
            minutes: 30,
            source: 'manual',
          },
        ],
      }}
      timezone="UTC"
      isPending={false}
      isError={false}
      onRetry={() => undefined}
      onClose={() => undefined}
    />,
  );

  expect(screen.getByText('Current activity name')).toBeTruthy();
  expect(screen.queryByText('Legacy activity name')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
