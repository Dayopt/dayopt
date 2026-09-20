import { describe, expect, it } from 'vitest';

import { hasTwoLayerTimeConflict } from '@/lib/time';

import type { CalendarDisplayEvent } from '../types/calendar.types';

import { buildNewTimeblockOverlapTarget, checkClientSideOverlapByKind } from './overlap';

function createEvent(
  overrides: Partial<CalendarDisplayEvent> & { id: string; startDate: Date; endDate: Date },
): CalendarDisplayEvent {
  return {
    title: 'Test',
    displayStartDate: overrides.startDate,
    displayEndDate: overrides.endDate,
    duration: 60,
    isMultiDay: false,

    status: 'open',
    color: '',
    createdAt: new Date(),
    updatedAt: new Date(),

    ...overrides,
  } as CalendarDisplayEvent;
}

describe('buildNewTimeblockOverlapTarget', () => {
  it('未来の新規予定はplannedのみ占有する（actualは未編集 = null）', () => {
    const start = new Date('2030-01-15T10:00');
    const end = new Date('2030-01-15T11:00');
    const target = buildNewTimeblockOverlapTarget(
      start,
      end,
      new Date('2026-01-15T09:00').getTime(),
    );

    expect(target).toMatchObject({
      id: '',
      plannedStart: start,
      plannedEnd: end,
      actualStart: null,
      actualEnd: null,
    });
    expect(hasTwoLayerTimeConflict([], target)).toBe(false);
  });

  it('過去の新規記録はplannedなし、actualありにする', () => {
    const start = new Date('2026-01-15T10:00');
    const end = new Date('2026-01-15T11:00');
    const target = buildNewTimeblockOverlapTarget(
      start,
      end,
      new Date('2026-01-15T12:00').getTime(),
    );

    expect(target).toMatchObject({
      id: '',
      plannedStart: null,
      plannedEnd: null,
      actualStart: start,
      actualEnd: end,
    });
    expect(hasTwoLayerTimeConflict([], target)).toBe(false);
  });
});

describe('checkClientSideOverlapByKind', () => {
  const now = new Date('2026-01-15T12:00').getTime();

  it('未来のPlanは重なるRecordがあっても作成できる', () => {
    const record = createEvent({
      id: 'record',
      kind: 'record',
      startDate: new Date('2026-01-16T10:00'),
      endDate: new Date('2026-01-16T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [record],
        '',
        new Date('2026-01-16T10:15'),
        new Date('2026-01-16T10:45'),
        { now },
      ),
    ).toBe(false);
  });

  it('未来のPlanは重なるPlanがあると作成できない', () => {
    const plan = createEvent({
      id: 'plan',
      kind: 'plan',
      startDate: new Date('2026-01-16T10:00'),
      endDate: new Date('2026-01-16T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [plan],
        '',
        new Date('2026-01-16T10:15'),
        new Date('2026-01-16T10:45'),
        { now },
      ),
    ).toBe(true);
  });

  it('過去のRecordは重なるPlanがあっても作成できる', () => {
    const plan = createEvent({
      id: 'plan',
      kind: 'plan',
      startDate: new Date('2026-01-15T10:00'),
      endDate: new Date('2026-01-15T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [plan],
        '',
        new Date('2026-01-15T10:15'),
        new Date('2026-01-15T10:45'),
        { now },
      ),
    ).toBe(false);
  });

  it('過去のRecordは重なるRecordがあると作成できない', () => {
    const record = createEvent({
      id: 'record',
      kind: 'record',
      startDate: new Date('2026-01-15T10:00'),
      endDate: new Date('2026-01-15T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [record],
        '',
        new Date('2026-01-15T10:15'),
        new Date('2026-01-15T10:45'),
        { now },
      ),
    ).toBe(true);
  });

  it('Plan→Record dropはドラッグ元PlanではなくRecordとの重複を判定する', () => {
    const plan = createEvent({
      id: 'plan',
      kind: 'plan',
      startDate: new Date('2026-01-15T09:00'),
      endDate: new Date('2026-01-15T10:00'),
    });
    const record = createEvent({
      id: 'record',
      kind: 'record',
      startDate: new Date('2026-01-15T10:00'),
      endDate: new Date('2026-01-15T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [plan, record],
        plan.id,
        new Date('2026-01-15T10:15'),
        new Date('2026-01-15T10:45'),
        { now, targetKind: 'record' },
      ),
    ).toBe(true);
  });

  it('Record→Plan laneでも元のRecord kindを指定すればPlan重複を無視する', () => {
    const record = createEvent({
      id: 'record',
      kind: 'record',
      startDate: new Date('2026-01-15T09:00'),
      endDate: new Date('2026-01-15T10:00'),
    });
    const plan = createEvent({
      id: 'plan',
      kind: 'plan',
      startDate: new Date('2026-01-15T10:00'),
      endDate: new Date('2026-01-15T11:00'),
    });

    expect(
      checkClientSideOverlapByKind(
        [record, plan],
        record.id,
        new Date('2026-01-15T10:15'),
        new Date('2026-01-15T10:45'),
        { now, targetKind: 'record' },
      ),
    ).toBe(false);
  });
});
