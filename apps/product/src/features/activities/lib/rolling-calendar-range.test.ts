import { describe, expect, it } from 'vitest';

import { clipMinutes, resolveRollingCalendarDaysRange } from './rolling-calendar-range';

describe('resolveRollingCalendarDaysRange', () => {
  it('counts timezone-local days across DST using half-open bounds', () => {
    const range = resolveRollingCalendarDaysRange(
      'America/New_York',
      new Date('2026-03-15T16:00:00.000Z'),
    );

    expect(range).toEqual({
      startAt: '2026-02-14T05:00:00.000Z',
      endAt: '2026-03-16T04:00:00.000Z',
      startDate: '2026-02-14',
      endDate: '2026-03-15',
    });
    expect(Date.parse(range.endAt) - Date.parse(range.startAt)).toBe(719 * 60 * 60 * 1000);
  });

  it('rejects non-positive or fractional day counts', () => {
    expect(() => resolveRollingCalendarDaysRange('UTC', new Date(), 0)).toThrow(RangeError);
    expect(() => resolveRollingCalendarDaysRange('UTC', new Date(), 1.5)).toThrow(RangeError);
  });
});

describe('clipMinutes', () => {
  it('clips a boundary-crossing record and excludes the exclusive end', () => {
    expect(
      clipMinutes(
        '2026-01-01T23:30:00.000Z',
        '2026-01-02T00:30:00.000Z',
        '2026-01-02T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
      ),
    ).toBe(30);
    expect(
      clipMinutes(
        '2026-01-03T00:00:00.000Z',
        '2026-01-03T00:30:00.000Z',
        '2026-01-02T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
      ),
    ).toBe(0);
  });
});
