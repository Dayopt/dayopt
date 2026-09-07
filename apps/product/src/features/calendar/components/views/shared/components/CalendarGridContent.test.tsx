import type React from 'react';

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

const ghostMock = vi.hoisted(() => ({
  timeblockId: null as string | null,
  previewTime: {
    start: new Date('2026-07-15T10:00:00.000Z'),
    end: new Date('2026-07-15T11:00:00.000Z'),
  },
}));

vi.mock('@/features/activities', () => ({
  useActivitiesMap: () => ({ getActivityById: () => null }),
  getCategoryColorClasses: () => null,
  ActivityIcon: () => null,
}));

vi.mock('@/features/timeblock', () => ({
  formatDiffMinutes: (minutes: number) => `${minutes}`,
  isPlanRecordDrop: (source: string, target: string) => source === 'plan' && target === 'record',
  resolveTimeblockDestination: () => 'plan',
  useTimeblockWriteMutations: () => ({ createRecord: { mutate: vi.fn() } }),
}));

// ghost 変換ロジック自体は useConvertGhostEvent.test.ts が検証する。ここでは
// CalendarGridContent が tRPC / QueryClient context を必要とせず render できることだけを担保する。
vi.mock('../../../../hooks/operations/useConvertGhostEvent', () => ({
  useConvertGhostEvent: () => ({
    convertGhost: vi.fn(),
    dismissGhost: vi.fn(),
    isConverting: false,
    isDismissing: false,
  }),
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ defaultDuration: 30, timeFormat: '24h' }),
}));

vi.mock('@/features/calendar/interaction', () => ({
  useInteraction: () => ({
    state: { mode: 'idle' },
    handlers: {
      handlePointerDown: vi.fn(),
      handleTouchStart: vi.fn(),
      handleResizeStart: vi.fn(),
    },
  }),
}));

vi.mock('@/features/calendar/interaction/GhostRenderer', () => ({
  GhostRenderer: ({
    renderGhost,
  }: {
    renderGhost?: (params: {
      timeblockId: string;
      previewTime: { start: Date; end: Date };
    }) => React.ReactNode;
  }) =>
    ghostMock.timeblockId && renderGhost
      ? renderGhost({
          timeblockId: ghostMock.timeblockId,
          previewTime: ghostMock.previewTime,
        })
      : null,
}));

vi.mock('@/features/calendar/components/views/shared/hooks/useResponsiveHourHeight', () => ({
  useResponsiveHourHeight: () => 60,
}));

vi.mock('./CalendarDragSelection', () => ({
  CalendarDragSelection: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('./DragSelectionHighlight', () => ({ DragSelectionHighlight: () => null }));

vi.mock('./TwoLaneTimeblockRenderer', () => ({
  TwoLaneTimeblockRenderer: ({
    entry,
    position,
    showDayDiffMarker,
  }: {
    entry: CalendarDisplayEvent;
    position: { left: number; width: number };
    showDayDiffMarker?: boolean;
  }) => (
    <div
      data-testid={`two-lane-${entry.id}`}
      data-day-diff-marker={showDayDiffMarker ? 'true' : 'false'}
      data-lane-left={position.left}
      data-lane-width={position.width}
    />
  ),
}));

import { useCalendarDragStore } from '../../../../stores/useCalendarDragStore';
import {
  buildDragPreviewEntry,
  CalendarGridContent,
  resolveCalendarLanePresentation,
} from './CalendarGridContent';

function makeCalendarEvent(
  kind: 'plan' | 'record',
  overrides: Partial<CalendarDisplayEvent> = {},
): CalendarDisplayEvent {
  const startDate = new Date('2026-07-15T09:00:00.000Z');
  const endDate = new Date('2026-07-15T10:00:00.000Z');

  return {
    id: `${kind}-1`,
    title: kind,
    startDate,
    endDate,
    displayStartDate: startDate,
    displayEndDate: endDate,
    status: 'open',
    color: 'blue',
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    updatedAt: new Date('2026-07-15T00:00:00.000Z'),
    version: '2026-07-15T00:00:00.000000Z',
    duration: 60,
    isMultiDay: false,
    origin: kind === 'plan' ? 'planned' : 'unplanned',
    timeblockState: kind === 'plan' ? 'upcoming' : 'past',
    kind,
    ...overrides,
  };
}

describe('CalendarGridContent', () => {
  afterEach(() => {
    ghostMock.timeblockId = null;
    useCalendarDragStore.getState().endDrag();
  });

  it.each([
    ['day', false],
    ['3day', false],
    ['5day', true],
    ['week', true],
  ] as const)('%s は共通38%%レーンと表示密度を解決する', (viewMode, compactCards) => {
    expect(resolveCalendarLanePresentation(viewMode)).toEqual({
      planLaneWidthPercent: 38,
      compactCards,
    });
  });

  it('単一レーン表示では選択したレーンを全幅にする', () => {
    expect(resolveCalendarLanePresentation('week', 'plan')).toEqual({
      planLaneWidthPercent: 100,
      compactCards: true,
    });
    expect(resolveCalendarLanePresentation('week', 'record')).toEqual({
      planLaneWidthPercent: 0,
      compactCards: true,
    });
  });

  it('単一レーン表示では選択したkindだけを全幅で描画する', () => {
    const plan = makeCalendarEvent('plan');
    const record = makeCalendarEvent('record');
    const { rerender } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan, record]}
        viewMode="week"
        dayIndex={0}
        laneDisplayMode="plan"
      />,
    );

    expect(screen.getByTestId('two-lane-plan-1')).toHaveAttribute('data-lane-left', '0');
    expect(screen.getByTestId('two-lane-plan-1')).toHaveAttribute('data-lane-width', '100');
    expect(screen.queryByTestId('two-lane-record-1')).not.toBeInTheDocument();

    rerender(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan, record]}
        viewMode="week"
        dayIndex={0}
        laneDisplayMode="record"
      />,
    );

    expect(screen.getByTestId('two-lane-record-1')).toHaveAttribute('data-lane-left', '0');
    expect(screen.getByTestId('two-lane-record-1')).toHaveAttribute('data-lane-width', '100');
    expect(screen.queryByTestId('two-lane-plan-1')).not.toBeInTheDocument();
  });

  it('drag preview は planned と actual のズレを保って表示用 entry を作る', () => {
    const entry = {
      id: 'entry-1',
      title: 'dev',
      startDate: new Date('2026-06-04T13:00:00.000Z'),
      endDate: new Date('2026-06-04T15:00:00.000Z'),
      displayStartDate: new Date('2026-06-04T13:00:00.000Z'),
      displayEndDate: new Date('2026-06-04T15:00:00.000Z'),
      plannedStartDate: new Date('2026-06-04T13:00:00.000Z'),
      plannedEndDate: new Date('2026-06-04T15:00:00.000Z'),
      actualStartDate: new Date('2026-06-04T13:30:00.000Z'),
      actualEndDate: new Date('2026-06-04T16:45:00.000Z'),
      status: 'open' as const,
      color: 'blue',
      createdAt: new Date('2026-06-04T00:00:00.000Z'),
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
      version: '2026-06-04T00:00:00.000000Z',
      duration: 120,
      isMultiDay: false,
      origin: 'planned' as const,
      timeblockState: 'upcoming' as const,
    };

    const previewEntry = buildDragPreviewEntry(entry, {
      start: new Date('2026-06-04T15:00:00.000Z'),
      end: new Date('2026-06-04T17:00:00.000Z'),
    });

    expect(previewEntry.startDate?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
    expect(previewEntry.endDate?.toISOString()).toBe('2026-06-04T17:00:00.000Z');
    expect(previewEntry.plannedStartDate?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
    expect(previewEntry.plannedEndDate?.toISOString()).toBe('2026-06-04T17:00:00.000Z');
    expect(previewEntry.actualStartDate?.toISOString()).toBe('2026-06-04T15:30:00.000Z');
    expect(previewEntry.actualEndDate?.toISOString()).toBe('2026-06-04T18:45:00.000Z');
  });

  it('Planのdrag previewはPlanレーンのoutlineカードで表示する（#2250: previewTime に重なる Record が存在する場合は split 幅）', () => {
    const plan = makeCalendarEvent('plan');
    // ghostMock.previewTime（10:00-11:00 UTC）に重なる Record を counterpart として用意する。
    const counterpartRecord = makeCalendarEvent('record', {
      id: 'record-counterpart',
      startDate: new Date('2026-07-15T10:00:00.000Z'),
      endDate: new Date('2026-07-15T11:00:00.000Z'),
      displayStartDate: new Date('2026-07-15T10:00:00.000Z'),
      displayEndDate: new Date('2026-07-15T11:00:00.000Z'),
    });
    ghostMock.timeblockId = plan.id;
    useCalendarDragStore.getState().updateDrag({ targetLane: 'plan' });

    const { container } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan, counterpartRecord]}
        dayIndex={0}
      />,
    );

    const card = container.querySelector('[data-plan-lane-card]');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ left: '0%', width: 'calc(38% - 4px)' });
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
  });

  it('previewTime に重なる Record が無い場合、Plan の drag preview はフル幅になる（#2250 P1 regression）', () => {
    const plan = makeCalendarEvent('plan');
    ghostMock.timeblockId = plan.id;
    useCalendarDragStore.getState().updateDrag({ targetLane: 'plan' });

    const { container } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan]}
        dayIndex={0}
      />,
    );

    const card = container.querySelector('[data-plan-lane-card]');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ left: '0%', width: 'calc(100% - 4px)' });
  });

  it('PlanをRecordレーンへdragすると紐づくRecordの塗りカードでpreviewする（#2250: previewTime に重なる Plan が存在する場合は split 幅）', () => {
    const plan = makeCalendarEvent('plan');
    // ghostMock.previewTime（10:00-11:00 UTC）に重なる Plan を counterpart として用意する。
    const counterpartPlan = makeCalendarEvent('plan', {
      id: 'plan-counterpart',
      startDate: new Date('2026-07-15T10:00:00.000Z'),
      endDate: new Date('2026-07-15T11:00:00.000Z'),
      displayStartDate: new Date('2026-07-15T10:00:00.000Z'),
      displayEndDate: new Date('2026-07-15T11:00:00.000Z'),
    });
    ghostMock.timeblockId = plan.id;
    useCalendarDragStore.getState().updateDrag({ targetLane: 'record' });

    const { container } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan, counterpartPlan]}
        dayIndex={0}
      />,
    );

    const card = container.querySelector('[data-record-lane-card]');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('data-record-planned', 'true');
    expect(card).toHaveStyle({ left: '38%', width: 'calc(62% - 4px)' });
    expect(container.querySelector('[data-plan-lane-card]')).toBeNull();
  });

  it('previewTime に重なる Plan が無い場合、Record 変換 drag preview はフル幅になる（#2250 P1 regression）', () => {
    const plan = makeCalendarEvent('plan');
    ghostMock.timeblockId = plan.id;
    useCalendarDragStore.getState().updateDrag({ targetLane: 'record' });

    const { container } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[plan]}
        dayIndex={0}
      />,
    );

    const card = container.querySelector('[data-record-lane-card]');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ left: '0%', width: 'calc(100% - 4px)' });
  });

  it('RecordをPlanレーン上へdragしてもRecordの塗りカードを維持する', () => {
    const record = makeCalendarEvent('record', { planId: 'plan-1' });
    ghostMock.timeblockId = record.id;
    useCalendarDragStore.getState().updateDrag({ targetLane: 'plan' });

    const { container } = render(
      <CalendarGridContent
        date={new Date('2026-07-15T00:00:00.000Z')}
        entries={[record]}
        dayIndex={0}
      />,
    );

    expect(container.querySelector('[data-record-lane-card]')).not.toBeNull();
    expect(container.querySelector('[data-plan-lane-card]')).toBeNull();
  });

  it('通常TwoLaneカードへCompare対象のmarker状態を渡す', () => {
    const first = {
      id: 'entry-1',
      title: 'dev',
      startDate: new Date('2026-06-04T09:00:00.000Z'),
      endDate: new Date('2026-06-04T10:00:00.000Z'),
      displayStartDate: new Date('2026-06-04T09:00:00.000Z'),
      displayEndDate: new Date('2026-06-04T10:00:00.000Z'),
      status: 'open' as const,
      color: 'blue',
      createdAt: new Date('2026-06-04T00:00:00.000Z'),
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
      version: '2026-06-04T00:00:00.000000Z',
      duration: 60,
      isMultiDay: false,
      origin: 'planned' as const,
      timeblockState: 'upcoming' as const,
      kind: 'plan' as const,
    } satisfies CalendarDisplayEvent;
    const second = {
      ...first,
      id: 'entry-2',
      startDate: new Date('2026-06-04T10:00:00.000Z'),
      endDate: new Date('2026-06-04T11:00:00.000Z'),
      displayStartDate: new Date('2026-06-04T10:00:00.000Z'),
      displayEndDate: new Date('2026-06-04T11:00:00.000Z'),
    } satisfies CalendarDisplayEvent;

    render(
      <CalendarGridContent
        date={new Date('2026-06-04T00:00:00.000Z')}
        entries={[first, second]}
        dayIndex={0}
        dayDiffEntryIds={new Set([first.id])}
      />,
    );

    expect(screen.getByTestId('two-lane-entry-1')).toHaveAttribute('data-day-diff-marker', 'true');
    expect(screen.getByTestId('two-lane-entry-2')).toHaveAttribute('data-day-diff-marker', 'false');
  });
});
