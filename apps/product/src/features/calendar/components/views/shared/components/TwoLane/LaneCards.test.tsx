import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanEvent, RecordEvent } from '@/features/timeblock';

import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';

import { PlanLaneCard } from './PlanLaneCard';
import { RecordLaneCard } from './RecordLaneCard';

const position: TwoLanePosition = { top: 0, left: 0, width: 50, height: 60 };
const startDate = new Date('2026-07-14T09:00:00.000Z');
const endDate = new Date('2026-07-14T10:00:00.000Z');

const plan: PlanEvent = {
  id: 'plan-1',
  title: 'Legacy plan title',
  note: null,
  activityId: null,
  startDate,
  endDate,
  displayStartDate: startDate,
  displayEndDate: endDate,
  duration: 60,
  status: 'upcoming',
};

const record: RecordEvent = {
  id: 'record-1',
  title: 'Legacy record title',
  note: null,
  activityId: null,
  startDate,
  endDate,
  displayStartDate: startDate,
  displayEndDate: endDate,
  duration: 60,
};

describe('TwoLane cards', () => {
  it('Planカードはtitleではなくタグ名を表示する', () => {
    render(<PlanLaneCard event={plan} position={position} activityName="Deep Work" />);

    expect(screen.getByRole('button', { name: 'Deep Work' })).toBeInTheDocument();
    expect(screen.queryByText('Legacy plan title')).not.toBeInTheDocument();
  });

  it('カテゴリー所属の Plan カードは継承した icon を表示する', () => {
    const { container } = render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="Deep Work"
        activityIcon="briefcase"
        activityCategoryId="category-1"
      />,
    );

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('未分類（カテゴリー無所属）の Plan カードは icon を表示しない（#2235）', () => {
    const { container } = render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="Deep Work"
        activityIcon="briefcase"
        activityCategoryId={null}
      />,
    );

    expect(container.querySelector('svg')).toBeNull();
  });

  it('Recordカードはtitleではなくタグ名を表示する', () => {
    render(<RecordLaneCard event={record} position={position} activityName="Deep Work" />);

    expect(screen.getByRole('button', { name: 'Deep Work' })).toBeInTheDocument();
    expect(screen.queryByText('Legacy record title')).not.toBeInTheDocument();
  });

  it('カテゴリー所属の Record カードは継承した icon を表示する', () => {
    const { container } = render(
      <RecordLaneCard
        event={record}
        position={position}
        activityName="Deep Work"
        activityIcon="briefcase"
        activityCategoryId="category-1"
      />,
    );

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('未分類（カテゴリー無所属）の Record カードは icon を表示しない（#2235）', () => {
    const { container } = render(
      <RecordLaneCard
        event={record}
        position={position}
        activityName="Deep Work"
        activityIcon="briefcase"
        activityCategoryId={null}
      />,
    );

    expect(container.querySelector('svg')).toBeNull();
  });

  it('アクティビティを解決できない場合もtitleへフォールバックしない', () => {
    render(<PlanLaneCard event={plan} position={position} activityName={null} />);

    expect(screen.getByRole('button', { name: 'calendar.filter.noActivity' })).toBeInTheDocument();
    expect(screen.queryByText('Legacy plan title')).not.toBeInTheDocument();
  });

  it('drag ghostは操作・focus対象にしない', () => {
    const { container } = render(
      <div>
        <PlanLaneCard
          event={plan}
          position={position}
          activityName="Deep Work"
          interactive={false}
        />
        <RecordLaneCard
          event={record}
          position={position}
          activityName="Deep Work"
          interactive={false}
        />
      </div>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    for (const card of container.querySelectorAll(
      '[data-plan-lane-card], [data-record-lane-card]',
    )) {
      expect(card).toHaveClass('pointer-events-none');
      expect(card).not.toHaveAttribute('tabindex');
      expect(card).not.toHaveAttribute('data-entry-block');
      expect(card).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('Compare対象のPlanカードにmarkerを表示する', () => {
    const { container } = render(
      <PlanLaneCard event={plan} position={position} activityName="Deep Work" showDayDiffMarker />,
    );

    expect(container.querySelector('[data-entry-day-diff-marker]')).not.toBeNull();
  });

  it('Compare対象のRecordカードにmarkerを表示する', () => {
    const { container } = render(
      <RecordLaneCard
        event={record}
        position={position}
        activityName="Deep Work"
        showDayDiffMarker
      />,
    );

    expect(container.querySelector('[data-entry-day-diff-marker]')).not.toBeNull();
  });

  it('Compare対象でないカードにはmarkerを表示しない', () => {
    const { container } = render(
      <div>
        <PlanLaneCard event={plan} position={position} activityName="Deep Work" />
        <RecordLaneCard event={record} position={position} activityName="Deep Work" />
      </div>,
    );

    expect(container.querySelector('[data-entry-day-diff-marker]')).toBeNull();
  });

  it('Recordカードは差分0のbadgeを隠し、差分がある場合も中立色で表示する', () => {
    const { container, rerender } = render(
      <RecordLaneCard event={{ ...record }} position={position} activityName="Deep Work" />,
    );

    expect(container.querySelector('[data-record-diff-badge]')).toBeNull();

    rerender(<RecordLaneCard event={{ ...record }} position={position} activityName="Deep Work" />);

    const badge = container.querySelector('[data-record-diff-badge]');
    expect(badge).toBeNull();
  });
});
