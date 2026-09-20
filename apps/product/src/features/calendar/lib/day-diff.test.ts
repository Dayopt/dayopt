import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import { computeCalendarDayDiffs, filterCalendarDayDiffTimeblocks } from './day-diff';

const now = new Date('2026-06-18T23:00:00.000Z');

const DAY_BOUNDS = {
  dayStart: new Date('2026-06-18T00:00:00.000Z'),
  dayEnd: new Date('2026-06-19T00:00:00.000Z'),
};

function timeblock(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  const start = new Date('2026-06-18T09:00:00.000Z');
  const end = new Date('2026-06-18T10:00:00.000Z');

  return {
    id: 'plan-1',
    title: 'Focus',
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    color: 'var(--category-blue)',
    activityId: 'activity-1',
    version: '2026-07-15T00:00:00.000000Z',
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
    ...overrides,
  };
}

/** Record は Plan と同じ 1 組の時刻しか持たない（`kind` だけが違う） */
function record(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  const start = new Date('2026-06-18T12:00:00.000Z');
  const end = new Date('2026-06-18T12:45:00.000Z');

  return timeblock({
    id: 'record-1',
    kind: 'record',
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    duration: 45,
    ...overrides,
  });
}

describe('computeCalendarDayDiffs', () => {
  it('Plan は予定レンジと実績レンジが一致するので diff item に出さない', () => {
    const result = computeCalendarDayDiffs([timeblock()], now);

    expect(result.items).toHaveLength(0);
    expect(result.timeblockIds.has('plan-1')).toBe(false);
    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 60,
      missedMinutes: 0,
      diffMinutes: 0,
    });
  });

  it('Record は unplanned として集計する', () => {
    const result = computeCalendarDayDiffs([record()], now);

    expect(result.items).toMatchObject([{ kind: 'unplanned', actualMinutes: 45 }]);
    expect(result.timeblockIds.has('record-1')).toBe(true);
    expect(result.summary).toMatchObject({
      plannedMinutes: 0,
      actualMinutes: 45,
      unplannedMinutes: 45,
      diffMinutes: 45,
    });
  });

  it('長さが 0 以下になる Record は item にしない', () => {
    const start = new Date('2026-06-18T12:00:00.000Z');
    const result = computeCalendarDayDiffs([record({ startDate: start, endDate: start })], now);

    expect(result.items).toHaveLength(0);
    expect(result.summary.unplannedMinutes).toBe(0);
  });

  it('isDraft の timeblock は集計しない', () => {
    const result = computeCalendarDayDiffs([timeblock({ isDraft: true }), record()], now);

    expect(result.summary).toMatchObject({ plannedMinutes: 0, actualMinutes: 45 });
  });

  it('日跨ぎ timeblock の集計は表示日の範囲に clipping する', () => {
    const result = computeCalendarDayDiffs(
      [
        timeblock({
          startDate: new Date('2026-06-18T23:00:00.000Z'),
          endDate: new Date('2026-06-19T01:00:00.000Z'),
          displayStartDate: new Date('2026-06-18T23:00:00.000Z'),
          displayEndDate: new Date('2026-06-19T00:00:00.000Z'),
        }),
      ],
      DAY_BOUNDS,
    );

    expect(result.items).toHaveLength(0);
    expect(result.summary).toMatchObject({
      plannedMinutes: 60,
      actualMinutes: 60,
      diffMinutes: 0,
    });
  });
});

describe('filterCalendarDayDiffTimeblocks', () => {
  it('表示日に交差する timeblock だけを diff source に残す', () => {
    const outside = timeblock({
      id: 'plan-outside',
      startDate: new Date('2026-06-17T10:00:00.000Z'),
      endDate: new Date('2026-06-17T11:00:00.000Z'),
    });

    const source = filterCalendarDayDiffTimeblocks([timeblock(), outside], DAY_BOUNDS, () => true);

    expect(source.map((item) => item.id)).toEqual(['plan-1']);
  });

  it('アクティビティ filter を適用する', () => {
    const source = filterCalendarDayDiffTimeblocks(
      [timeblock()],
      DAY_BOUNDS,
      (activityId) => activityId !== 'activity-1',
    );

    expect(source).toHaveLength(0);
  });
});
