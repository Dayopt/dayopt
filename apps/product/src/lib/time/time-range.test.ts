import { describe, expect, it } from 'vitest';

import { createTimeRange, getTimeRangeDurationMs, isValidTimeRange } from './time-range';

describe('time range contract', () => {
  it('creates an independent copy of both endpoints', () => {
    // 守ること: 呼び出し元の Date 変更で保存済みの時間範囲を変えない。
    const start = new Date('2026-09-29T09:00:00Z');
    const end = new Date('2026-09-29T10:00:00Z');
    const range = createTimeRange(start, end);
    start.setTime(0);
    end.setTime(0);
    expect(range.start.toISOString()).toBe('2026-09-29T09:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-29T10:00:00.000Z');
    expect(getTimeRangeDurationMs(range)).toBe(3_600_000);
    expect(isValidTimeRange(range)).toBe(true);
  });

  it.each([
    [0, 0, 0],
    [1000, 0, -1000],
    [Number.NaN, 1000, Number.NaN],
    [0, Number.NaN, Number.NaN],
  ])('rejects zero, reversed, or invalid endpoints (%s, %s)', (start, end, duration) => {
    // 守ること: DT003 に反するゼロ長・逆転・不正時刻は有効範囲にしない。
    const range = createTimeRange(new Date(start), new Date(end));
    expect(isValidTimeRange(range)).toBe(false);
    expect(getTimeRangeDurationMs(range)).toBe(duration);
  });

  it('accepts one millisecond without rounding away the interval', () => {
    // 守ること: 正の最小境界をゼロ長へ丸めない。
    const range = createTimeRange(new Date(0), new Date(1));
    expect(isValidTimeRange(range)).toBe(true);
    expect(getTimeRangeDurationMs(range)).toBe(1);
  });
});
