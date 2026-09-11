import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import { computeCalendarDayDiffs, filterCalendarDayDiffEntries } from './day-diff';

const now = new Date('2026-06-18T23:00:00.000Z');

function entry(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  const start = new Date('2026-06-18T09:00:00.000Z');
  const end = new Date('2026-06-18T10:00:00.000Z');

  return {
    id: 'entry-1',
    title: 'Focus',
    startDate: start,
    endDate: end,
    plannedStartDate: start,
    plannedEndDate: end,
    actualStartDate: start,
    actualEndDate: end,
    displayStartDate: start,
    displayEndDate: end,
    status: 'closed',
    color: 'var(--category-blue)',
    activityId: 'activity-1',
    createdAt: start,
    updatedAt: end,
    version: '2026-07-15T00:00:00.000000Z',
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
    ...overrides,
  };
}

describe('computeCalendarDayDiffs', () => {
  it('planned と actual が一致する entry は diff item に出さない', () => {
    const result = computeCalendarDayDiffs([entry()], now);

    expect(result.items).toHaveLength(0);
    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 60,
      diffMinutes: 0,
    });
  });

  it('unplanned entry は addition として集計する', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          id: 'unplanned-1',
          kind: 'record',
          startDate: new Date('2026-06-18T12:00:00.000Z'),
          endDate: new Date('2026-06-18T12:45:00.000Z'),
          plannedStartDate: null,
          plannedEndDate: null,
          actualStartDate: new Date('2026-06-18T12:00:00.000Z'),
          actualEndDate: new Date('2026-06-18T12:45:00.000Z'),
          displayStartDate: new Date('2026-06-18T12:00:00.000Z'),
          displayEndDate: new Date('2026-06-18T12:45:00.000Z'),
        }),
      ],
      now,
    );

    expect(result.items).toMatchObject([{ kind: 'unplanned', actualMinutes: 45 }]);
    expect(result.summary.unplannedMinutes).toBe(45);
    expect(result.summary.diffMinutes).toBe(45);
  });

  it('実績未編集の planned entry は予定どおりとして差分に出さない', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualStartDate: null,
          actualEndDate: null,
        }),
      ],
      now,
    );

    expect(result.items).toHaveLength(0);
    expect(result.timeblockIds.has('entry-1')).toBe(false);
    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 60,
      missedMinutes: 0,
      diffMinutes: 0,
    });
  });

  it('開始がずれた planned entry は shifted にする', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualStartDate: new Date('2026-06-18T09:20:00.000Z'),
          actualEndDate: new Date('2026-06-18T10:20:00.000Z'),
        }),
      ],
      now,
    );

    expect(result.items).toMatchObject([{ kind: 'shifted', startDiffMinutes: 20, diffMinutes: 0 }]);
  });

  it('actual start だけ編集された planned entry も shifted にする', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualStartDate: new Date('2026-06-18T09:20:00.000Z'),
          actualEndDate: null,
        }),
      ],
      now,
    );

    expect(result.items).toMatchObject([
      { kind: 'shifted', startDiffMinutes: 20, endDiffMinutes: 0, diffMinutes: -20 },
    ]);
  });

  it('actual end だけ編集された planned entry も resized にする', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualStartDate: null,
          actualEndDate: new Date('2026-06-18T10:30:00.000Z'),
        }),
      ],
      now,
    );

    expect(result.items).toMatchObject([
      { kind: 'resized', startDiffMinutes: 0, endDiffMinutes: 30, diffMinutes: 30 },
    ]);
  });

  it('開始は同じで duration だけ変わった planned entry は resized にする', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualEndDate: new Date('2026-06-18T10:30:00.000Z'),
        }),
      ],
      now,
    );

    expect(result.items).toMatchObject([{ kind: 'resized', diffMinutes: 30 }]);
  });

  it('日跨ぎ entry の集計は表示日の範囲に clipping する', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          startDate: new Date('2026-06-18T23:00:00.000Z'),
          endDate: new Date('2026-06-19T01:00:00.000Z'),
          plannedStartDate: new Date('2026-06-18T23:00:00.000Z'),
          plannedEndDate: new Date('2026-06-19T01:00:00.000Z'),
          actualStartDate: new Date('2026-06-18T23:00:00.000Z'),
          actualEndDate: new Date('2026-06-19T01:00:00.000Z'),
          displayStartDate: new Date('2026-06-18T23:00:00.000Z'),
          displayEndDate: new Date('2026-06-19T00:00:00.000Z'),
        }),
      ],
      {
        dayStart: new Date('2026-06-18T00:00:00.000Z'),
        dayEnd: new Date('2026-06-19T00:00:00.000Z'),
      },
    );

    expect(result.items).toHaveLength(0);
    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 60,
      diffMinutes: 0,
    });
  });

  it('planned が別日でも actual が表示日に交差する entry を diff source に含める', () => {
    const bounds = {
      dayStart: new Date('2026-06-18T00:00:00.000Z'),
      dayEnd: new Date('2026-06-19T00:00:00.000Z'),
    };
    const entries = [
      entry({
        startDate: new Date('2026-06-17T10:00:00.000Z'),
        endDate: new Date('2026-06-17T11:00:00.000Z'),
        plannedStartDate: new Date('2026-06-17T10:00:00.000Z'),
        plannedEndDate: new Date('2026-06-17T11:00:00.000Z'),
        actualStartDate: new Date('2026-06-18T09:00:00.000Z'),
        actualEndDate: new Date('2026-06-18T10:00:00.000Z'),
      }),
    ];

    const source = filterCalendarDayDiffEntries(entries, bounds, () => true);
    const result = computeCalendarDayDiffs(source, bounds);

    expect(source).toHaveLength(1);
    expect(result.summary).toMatchObject({ plannedMinutes: 0, actualMinutes: 60, diffMinutes: 60 });
    expect(result.items).toMatchObject([{ timeblockId: 'entry-1', actualMinutes: 60 }]);
  });

  it('diff source は アクティビティ filter を適用する', () => {
    const source = filterCalendarDayDiffEntries(
      [entry()],
      {
        dayStart: new Date('2026-06-18T00:00:00.000Z'),
        dayEnd: new Date('2026-06-19T00:00:00.000Z'),
      },
      (activityId) => activityId !== 'activity-1',
    );

    expect(source).toHaveLength(0);
  });

  it('actual が表示日から出た planned entry も item に残す', () => {
    const result = computeCalendarDayDiffs(
      [
        entry({
          actualStartDate: new Date('2026-06-19T09:00:00.000Z'),
          actualEndDate: new Date('2026-06-19T10:00:00.000Z'),
        }),
      ],
      {
        dayStart: new Date('2026-06-18T00:00:00.000Z'),
        dayEnd: new Date('2026-06-19T00:00:00.000Z'),
      },
    );

    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 0,
      diffMinutes: -60,
    });
    expect(result.items).toMatchObject([
      { kind: 'shifted', timeblockId: 'entry-1', diffMinutes: -60 },
    ]);
    expect(result.timeblockIds.has('entry-1')).toBe(true);
  });
});
