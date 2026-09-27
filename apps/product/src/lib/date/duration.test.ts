import { describe, expect, it } from 'vitest';

import { formatDurationMinutes } from './duration';

describe('date/duration', () => {
  it.each([
    [0, '0m'],
    [59, '59m'],
    [60, '1h'],
    [61, '1h 1m'],
  ])('formats the integer boundary %i as %s', (input, expected) => {
    expect(formatDurationMinutes(input)).toBe(expected);
  });

  it('rounds fractional minutes before formatting', () => {
    expect(formatDurationMinutes(59.6)).toBe('60m');
    expect(formatDurationMinutes(90.5)).toBe('1h 31m');
  });

  it('formats negative input by magnitude', () => {
    expect(formatDurationMinutes(-90)).toBe('1h 30m');
  });
});
