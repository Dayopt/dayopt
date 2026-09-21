import { describe, expect, it } from 'vitest';

import {
  getTimezoneAbbreviation,
  getTimezoneOffset,
  localTimeToUTCISO,
  parseISOToUserTimezone,
} from './timezone';

describe('localTimeToUTCISO', () => {
  it.each([
    ['JST normal', new Date(2025, 0, 22), 14, 30, 'Asia/Tokyo', '2025-01-22T05:30:00.000Z'],
    ['JST day boundary', new Date(2025, 0, 22), 0, 30, 'Asia/Tokyo', '2025-01-21T15:30:00.000Z'],
    [
      'IST half-hour offset',
      new Date(2025, 0, 22),
      14,
      0,
      'Asia/Kolkata',
      '2025-01-22T08:30:00.000Z',
    ],
    [
      'NY before spring forward',
      new Date(2025, 2, 9),
      1,
      0,
      'America/New_York',
      '2025-03-09T06:00:00.000Z',
    ],
    [
      'NY after spring forward',
      new Date(2025, 2, 9),
      3,
      0,
      'America/New_York',
      '2025-03-09T07:00:00.000Z',
    ],
    [
      'NY after fall back',
      new Date(2025, 10, 2),
      12,
      0,
      'America/New_York',
      '2025-11-02T17:00:00.000Z',
    ],
  ])('%s', (_label, date, hours, minutes, timezone, expected) => {
    expect(localTimeToUTCISO(date, hours, minutes, timezone)).toBe(expected);
  });
});

describe('parseISOToUserTimezone', () => {
  it.each([
    ['2025-01-22T05:30:00.000Z', 'Asia/Tokyo', 14, 30],
    ['2025-01-22T15:00:00.000Z', 'America/New_York', 10, 0],
  ])('converts UTC into %s local fields', (iso, timezone, hours, minutes) => {
    const result = parseISOToUserTimezone(iso, timezone);
    expect(result.getHours()).toBe(hours);
    expect(result.getMinutes()).toBe(minutes);
  });

  it('rejects invalid ISO input', () => {
    expect(() => parseISOToUserTimezone('not-a-date', 'Asia/Tokyo')).toThrow(
      'Invalid ISO datetime',
    );
  });
});

describe('getTimezoneOffset', () => {
  it.each([
    ['UTC', new Date('2025-01-15T12:00:00Z'), 0],
    ['Asia/Tokyo', new Date('2025-01-15T12:00:00Z'), 9],
    ['America/New_York', new Date('2025-07-15T12:00:00Z'), -4],
    ['America/New_York', new Date('2025-01-15T12:00:00Z'), -5],
  ])('%s at %s has offset %s', (timezone, date, expected) => {
    expect(getTimezoneOffset(timezone, date)).toBe(expected);
  });
});

describe('getTimezoneAbbreviation', () => {
  it('reflects DST and falls back to UTC for an invalid zone', () => {
    expect(getTimezoneAbbreviation('UTC', new Date('2025-01-15T12:00:00Z'))).toBe('UTC');
    expect(getTimezoneAbbreviation('America/New_York', new Date('2025-07-15T12:00:00Z'))).toBe(
      'EDT',
    );
    expect(getTimezoneAbbreviation('America/New_York', new Date('2025-01-15T12:00:00Z'))).toBe(
      'EST',
    );
    expect(getTimezoneAbbreviation('Invalid/Zone', new Date('2025-01-15T12:00:00Z'))).toBe('UTC');
  });
});
