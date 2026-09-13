import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import {
  computeRemainingDayMinutes,
  DAY_MINUTES,
  formatRemainingDuration,
  planRangesFromCalendarEvents,
} from './remaining-day-minutes';

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

describe('computeRemainingDayMinutes', () => {
  it('予定の暦日はユーザー TZ で判定する（23:30Z は Asia/Tokyo では翌日）', () => {
    const plans = [{ start: '2026-06-18T23:30:00.000Z', end: '2026-06-19T00:30:00.000Z' }] as const;

    // Asia/Tokyo では 6/19 08:30-09:30 なので 6/19 に数える
    expect(
      computeRemainingDayMinutes({
        plans,
        dateKey: '2026-06-19',
        timezone: 'Asia/Tokyo',
        selectionMinutes: 0,
      }),
    ).toBe(DAY_MINUTES - 60);
    expect(
      computeRemainingDayMinutes({
        plans,
        dateKey: '2026-06-18',
        timezone: 'Asia/Tokyo',
        selectionMinutes: 0,
      }),
    ).toBe(DAY_MINUTES);

    // UTC では 6/18 23:30 開始なので 6/18 に数える
    expect(
      computeRemainingDayMinutes({
        plans,
        dateKey: '2026-06-18',
        timezone: 'UTC',
        selectionMinutes: 0,
      }),
    ).toBe(DAY_MINUTES - 60);
  });

  it('選択中の長さを引く', () => {
    const result = computeRemainingDayMinutes({
      plans: [
        { start: '2026-06-18T09:00:00.000Z', end: '2026-06-18T10:00:00.000Z' },
        { start: '2026-06-18T11:00:00.000Z', end: '2026-06-18T12:00:00.000Z' },
      ],
      dateKey: '2026-06-18',
      timezone: 'UTC',
      selectionMinutes: 120,
    });

    expect(result).toBe(DAY_MINUTES - 60 - 60 - 120);
  });

  it('isDraft と不正な日時は数えない', () => {
    const result = computeRemainingDayMinutes({
      plans: [
        { start: '2026-06-18T09:00:00.000Z', end: '2026-06-18T10:00:00.000Z', isDraft: true },
        { start: 'not-a-date', end: '2026-06-18T10:00:00.000Z' },
        { start: '2026-06-18T13:00:00.000Z', end: '2026-06-18T12:00:00.000Z' },
      ],
      dateKey: '2026-06-18',
      timezone: 'UTC',
      selectionMinutes: 0,
    });

    expect(result).toBe(DAY_MINUTES);
  });

  it('Date と ISO 文字列の両方を受ける', () => {
    const result = computeRemainingDayMinutes({
      plans: [
        { start: new Date('2026-06-18T09:00:00.000Z'), end: new Date('2026-06-18T10:00:00.000Z') },
        { start: '2026-06-18T11:00:00.000Z', end: '2026-06-18T12:00:00.000Z' },
      ],
      dateKey: '2026-06-18',
      timezone: 'UTC',
      selectionMinutes: 0,
    });

    expect(result).toBe(DAY_MINUTES - 120);
  });

  it('24h を超えて置いている日は負になる', () => {
    const result = computeRemainingDayMinutes({
      plans: [
        { start: '2026-06-18T00:00:00.000Z', end: '2026-06-18T08:00:00.000Z' },
        { start: '2026-06-18T08:00:00.000Z', end: '2026-06-18T16:00:00.000Z' },
        { start: '2026-06-18T16:00:00.000Z', end: '2026-06-19T00:00:00.000Z' },
      ],
      dateKey: '2026-06-18',
      timezone: 'UTC',
      selectionMinutes: 120,
    });

    expect(result).toBe(-120);
  });
});

describe('planRangesFromCalendarEvents', () => {
  it('記録は落とし、planned の時刻を優先する', () => {
    const plannedStart = new Date('2026-06-18T09:00:00.000Z');
    const plannedEnd = new Date('2026-06-18T10:30:00.000Z');

    const ranges = planRangesFromCalendarEvents([
      entry({
        plannedStartDate: plannedStart,
        plannedEndDate: plannedEnd,
        startDate: new Date('2026-06-18T20:00:00.000Z'),
        endDate: new Date('2026-06-18T21:00:00.000Z'),
      }),
      entry({ id: 'record-1', kind: 'record' }),
    ]);

    expect(ranges).toEqual([{ start: plannedStart, end: plannedEnd, isDraft: undefined }]);
  });

  it('planned が無ければ startDate / endDate を使い、時刻欠損は落とす', () => {
    const ranges = planRangesFromCalendarEvents([
      entry({
        plannedStartDate: undefined,
        plannedEndDate: undefined,
      }),
      entry({
        id: 'no-time',
        startDate: null,
        endDate: null,
        plannedStartDate: undefined,
        plannedEndDate: undefined,
      }),
    ]);

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toEqual(new Date('2026-06-18T09:00:00.000Z'));
  });

  it('isDraft を引き継ぐ', () => {
    const ranges = planRangesFromCalendarEvents([entry({ isDraft: true })]);

    expect(ranges[0]?.isDraft).toBe(true);
  });
});

describe('formatRemainingDuration', () => {
  it('負の値は符号だけで示す', () => {
    expect(formatRemainingDuration(-120)).toBe('-2h');
    expect(formatRemainingDuration(-45)).toBe('-45m');
  });

  it('正の値は既存の期間表記に従う', () => {
    expect(formatRemainingDuration(170)).toBe('2h 50m');
    expect(formatRemainingDuration(60)).toBe('1h');
    expect(formatRemainingDuration(0)).toBe('0m');
  });
});
