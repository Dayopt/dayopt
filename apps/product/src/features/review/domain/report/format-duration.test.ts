import { describe, expect, it } from 'vitest';

import {
  formatReportDelta,
  formatReportDuration,
  formatReportSpan,
  formatReportSpanDelta,
} from './format-duration';

describe('formatReportDuration', () => {
  it.each([
    [45, '0:45'],
    [65, '1:05'],
    [90.6, '1:31'],
    [59.6, '1:00'],
    [60 * 1234, '1234:00'],
    [-90, '1:30'],
  ])('formats %s minutes as %s', (minutes, expected) => {
    expect(formatReportDuration(minutes)).toBe(expected);
  });
});

describe('formatReportDelta', () => {
  it.each([
    [130, '+2:10'],
    [-40, '−0:40'],
    [0.4, '0:00'],
  ])('formats %s as %s', (minutes, expected) => {
    expect(formatReportDelta(minutes)).toBe(expected);
  });
});

describe('formatReportSpan', () => {
  it.each([
    [1720, 'ja', '28時間40分'],
    [12, 'ja', '12分'],
    [180, 'ja', '3時間'],
    [1720, 'en', '28h 40m'],
    [12, 'en', '12m'],
    [180, 'en', '3h'],
    [59.6, 'ja', '1時間'],
  ])('formats %s minutes in %s as %s', (minutes, locale, expected) => {
    expect(formatReportSpan(minutes, locale as 'ja' | 'en')).toBe(expected);
  });
});

describe('formatReportSpanDelta', () => {
  it('formats positive, negative, and zero deltas', () => {
    expect(formatReportSpanDelta(90, 'ja')).toBe('+1時間30分');
    expect(formatReportSpanDelta(-189, 'ja')).toBe('−3時間9分');
    expect(formatReportSpanDelta(0, 'ja')).toBe('0分');
  });
});
