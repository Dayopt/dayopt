import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanEvent, RecordEvent } from '@/features/timeblock';
import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';

import { PlanLaneCard } from './PlanLaneCard';
import { RecordLaneCard } from './RecordLaneCard';

const position: TwoLanePosition = { top: 0, left: 0, width: 100, height: 72 };
const start = new Date(2026, 6, 15, 13, 5);
const end = new Date(2026, 6, 15, 14, 30);

const plan: PlanEvent = {
  id: 'plan-1',
  title: 'Focus',
  note: null,
  activityId: null,
  startDate: start,
  endDate: end,
  displayStartDate: start,
  displayEndDate: end,
  duration: 85,
  status: 'upcoming',
};

const record: RecordEvent = {
  id: 'record-1',
  title: 'Focus',
  note: null,
  activityId: null,
  startDate: start,
  endDate: end,
  displayStartDate: start,
  displayEndDate: end,
  duration: 85,
};

describe('TwoLane cards time format', () => {
  it('Planカードを12時間表記で表示する', () => {
    render(<PlanLaneCard event={plan} position={position} activityName="Focus" timeFormat="12h" />);

    expect(screen.getByText('1:05 PM–2:30 PM')).toBeInTheDocument();
  });

  it('Recordカードを12時間表記で表示する', () => {
    render(
      <RecordLaneCard event={record} position={position} activityName="Focus" timeFormat="12h" />,
    );

    expect(screen.getByText('1:05 PM–2:30 PM')).toBeInTheDocument();
  });
});

describe('TwoLane cards keyboard interaction', () => {
  it('PlanカードをbuttonとしてEnterで開く', () => {
    const onClick = vi.fn();
    render(
      <PlanLaneCard event={plan} position={position} activityName="Focus" onClick={onClick} />,
    );

    const card = screen.getByRole('button', { name: 'Focus' });
    expect(card).toHaveClass('focus-visible:ring-ring');
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(onClick).toHaveBeenCalledWith(plan, expect.any(Object));
  });

  it('RecordカードをbuttonとしてSpaceで開く', () => {
    const onClick = vi.fn();
    render(
      <RecordLaneCard event={record} position={position} activityName="Focus" onClick={onClick} />,
    );

    const card = screen.getByRole('button', { name: 'Focus' });
    expect(card).toHaveClass('focus-visible:ring-ring');
    fireEvent.keyDown(card, { key: ' ' });

    expect(onClick).toHaveBeenCalledWith(record, expect.any(Object));
  });
});
