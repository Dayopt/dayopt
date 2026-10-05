import { describe, expect, it } from 'vitest';

import { getMonthlyUsd, getMonthlyUsdCents } from './pricing';

describe('price units', () => {
  it('converts the paid monthly price from cents to dollars once', () => {
    // 守ること: 500 cents を 5 dollars とし、単位変換の誤りを検出する。
    expect(getMonthlyUsdCents('pro')).toBe(500);
    expect(getMonthlyUsd('pro')).toBe(5);
  });

  it('preserves the zero-price boundary', () => {
    // 守ること: 無料プランの価格を変換の前後ともゼロに保つ。
    expect(getMonthlyUsdCents('free')).toBe(0);
    expect(getMonthlyUsd('free')).toBe(0);
  });
});
