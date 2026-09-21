import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addWeeks,
  endOfDay,
  endOfMonth,
  endOfWeek,
  generateDateRange,
  getDateKey,
  getDaysDifference,
  getMonthDates,
  getMonthKey,
  getTimeDifference,
  getWeekDates,
  isAfter,
  isBefore,
  isSameDay,
  isToday,
  isTomorrow,
  isValidDate,
  isWeekend,
  isWithinRange,
  isYesterday,
  normalizeDate,
  parseDateString,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
} from './core';

describe('Date Core Utilities', () => {
  afterEach(() => vi.useRealTimers());

  it('returns day boundaries without mutating the input', () => {
    const date = new Date('2024-01-15T14:30:45.123');
    const originalTime = date.getTime();

    const start = startOfDay(date);
    const end = endOfDay(date);

    expect(start).toEqual(new Date('2024-01-15T00:00:00.000'));
    expect(end).toEqual(new Date('2024-01-15T23:59:59.999'));
    expect(date.getTime()).toBe(originalTime);
  });

  it('uses Monday by default and honors a Sunday week start', () => {
    const date = new Date('2024-01-17T10:00:00');

    expect(startOfWeek(date)).toEqual(new Date('2024-01-15T00:00:00'));
    expect(startOfWeek(date, { weekStartsOn: 0 })).toEqual(new Date('2024-01-14T00:00:00'));
  });

  it('returns a Sunday-ending week at the end of the day', () => {
    expect(endOfWeek(new Date('2024-01-17T10:00:00'))).toEqual(new Date('2024-01-21T23:59:59.999'));
  });

  it('returns month boundaries, including a leap-year February', () => {
    expect(startOfMonth(new Date('2024-01-15T14:30:00'))).toEqual(new Date('2024-01-01T00:00:00'));
    expect(endOfMonth(new Date('2024-02-15T10:00:00'))).toEqual(
      new Date('2024-02-29T23:59:59.999'),
    );
  });

  it.each([
    ['addDays rollover', () => addDays(new Date('2024-01-30'), 5), new Date('2024-02-04')],
    ['subDays', () => subDays(new Date('2024-01-15'), 5), new Date('2024-01-10')],
    ['addWeeks', () => addWeeks(new Date('2024-01-15'), 2), new Date('2024-01-29')],
    ['addMonths year rollover', () => addMonths(new Date('2024-11-15'), 3), new Date('2025-02-15')],
    [
      'addMinutes hour rollover',
      () => addMinutes(new Date('2024-01-15T10:30:00'), 45),
      new Date('2024-01-15T11:15:00'),
    ],
    [
      'addHours day rollover',
      () => addHours(new Date('2024-01-15T22:00:00'), 5),
      new Date('2024-01-16T03:00:00'),
    ],
  ])('%s', (_label, calculate, expected) => {
    expect(calculate()).toEqual(expected);
  });

  it.each([
    [new Date('2024-01-15T10:00:00'), new Date('2024-01-15T20:00:00'), true],
    [new Date('2024-01-15'), new Date('2024-01-16'), false],
  ])('compares calendar days', (date1, date2, expected) => {
    expect(isSameDay(date1, date2)).toBe(expected);
  });

  it('resolves today, tomorrow, and yesterday from the current date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00'));

    expect(isToday(new Date('2024-01-15T08:00:00'))).toBe(true);
    expect(isTomorrow(new Date('2024-01-16T08:00:00'))).toBe(true);
    expect(isYesterday(new Date('2024-01-14T08:00:00'))).toBe(true);
    expect(isTomorrow(new Date('2024-01-15T08:00:00'))).toBe(false);
  });

  it.each([
    [new Date('2024-01-13'), true],
    [new Date('2024-01-14'), true],
    [new Date('2024-01-15'), false],
  ])('classifies weekend days', (date, expected) => {
    expect(isWeekend(date)).toBe(expected);
  });

  it.each([
    [isBefore, new Date('2024-01-15'), new Date('2024-01-20'), true],
    [isAfter, new Date('2024-01-20'), new Date('2024-01-15'), true],
  ])('compares ordered instants', (compare, first, second, expected) => {
    expect(compare(first, second)).toBe(expected);
  });

  it('treats both range endpoints as included', () => {
    const start = new Date('2024-01-10');
    const end = new Date('2024-01-20');

    expect(isWithinRange(start, start, end)).toBe(true);
    expect(isWithinRange(end, start, end)).toBe(true);
    expect(isWithinRange(new Date('2024-01-25'), start, end)).toBe(false);
  });

  it('calculates signed day and millisecond differences', () => {
    expect(getDaysDifference(new Date('2024-01-10'), new Date('2024-01-15'))).toBe(5);
    expect(getDaysDifference(new Date('2024-01-15'), new Date('2024-01-10'))).toBe(-5);
    expect(
      getDaysDifference(new Date('2024-01-15T10:00:00'), new Date('2024-01-15T20:00:00')),
    ).toBe(0);
    expect(
      getTimeDifference(new Date('2024-01-15T10:00:00'), new Date('2024-01-15T11:00:00')),
    ).toBe(60 * 60 * 1000);
  });

  it('generates an inclusive range, including a single-day range', () => {
    expect(generateDateRange(new Date('2024-01-15'), new Date('2024-01-18'))).toHaveLength(4);
    expect(generateDateRange(new Date('2024-01-15'), new Date('2024-01-15'))).toHaveLength(1);
  });

  it('generates Monday-first weeks and leap-year months', () => {
    const week = getWeekDates(new Date('2024-01-17'));
    expect(week).toHaveLength(7);
    expect(week[0]).toEqual(new Date('2024-01-15T00:00:00'));

    expect(getMonthDates(new Date('2024-02-15'))).toHaveLength(29);
  });

  it('generates local and timezone-aware date keys', () => {
    const date = new Date('2026-03-29T15:30:00.000Z');

    expect(getDateKey(new Date('2024-01-05'))).toBe('2024-01-05');
    expect(getDateKey(date, 'Asia/Tokyo')).toBe('2026-03-30');
    expect(getDateKey(date, 'America/New_York')).toBe('2026-03-29');
    expect(getMonthKey(new Date('2024-01-15'))).toBe('2024-01');
  });

  it('parses local calendar dates and rejects non-ISO input', () => {
    const result = parseDateString('2024-01-15');

    expect(result).toEqual(new Date(2024, 0, 15));
    expect(result.getHours()).toBe(0);
    expect(() => parseDateString('2024/01/15')).toThrow('Invalid date format');
  });

  it.each([
    [new Date('2024-01-15'), new Date('2024-01-15')],
    ['2024-01-15T10:00:00', new Date('2024-01-15T10:00:00')],
    [null, null],
    [undefined, null],
    ['invalid', null],
  ])('normalizes date input', (value, expected) => {
    const result = normalizeDate(value);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toEqual(expected);
    }
  });

  it('distinguishes valid and invalid Date instances', () => {
    expect(isValidDate(new Date('2024-01-15'))).toBe(true);
    expect(isValidDate(new Date('invalid'))).toBe(false);
  });
});
