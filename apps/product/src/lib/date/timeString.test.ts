import { describe, expect, it } from 'vitest';

import { computeDuration, formatTimeRange } from './timeString';

describe('date/timeString', () => {
  it('formats 24h, 12h, and a custom separator', () => {
    const start = new Date(2026, 0, 15, 9, 0);
    const end = new Date(2026, 0, 15, 17, 30);

    expect(formatTimeRange(start, end, '24h')).toBe('09:00–17:30');
    expect(formatTimeRange(start, end, '12h')).toBe('9:00 AM–5:30 PM');
    expect(formatTimeRange(start, end, '24h', ' – ')).toBe('09:00 – 17:30');
  });

  it.each([
    ['normal duration', '09:00', '10:00', 60],
    ['one-minute boundary', '09:00', '09:01', 1],
    ['non-positive duration', '10:00', '09:00', 0],
    ['invalid input', '', '10:00', 0],
  ])('%s', (_label, start, end, expected) => {
    expect(computeDuration(start, end)).toBe(expected);
  });
});
