import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import { hasCalendarActualRangeDiff } from './timeblock-time';

function makeTimeblock(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  const start = new Date('2026-06-10T08:00:00.000Z');
  const end = new Date('2026-06-10T09:00:00.000Z');
  return {
    id: 'entry-1',
    title: 'entry',
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    plannedStartDate: start,
    plannedEndDate: end,
    actualStartDate: start,
    actualEndDate: end,
    status: 'open',
    color: 'blue',
    createdAt: start,
    updatedAt: start,
    version: '2026-07-15T00:00:00.000000Z',
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
    ...overrides,
  };
}

describe('hasCalendarActualRangeDiff', () => {
  it('予定と記録が一致する通常 entry は false', () => {
    expect(hasCalendarActualRangeDiff(makeTimeblock())).toBe(false);
  });

  it('記録が予定を超過している entry は true', () => {
    expect(
      hasCalendarActualRangeDiff(
        makeTimeblock({ actualEndDate: new Date('2026-06-10T09:10:00.000Z') }),
      ),
    ).toBe(true);
  });

  it('actual がない予定だけ entry は true', () => {
    expect(
      hasCalendarActualRangeDiff(makeTimeblock({ actualStartDate: null, actualEndDate: null })),
    ).toBe(true);
  });
});
