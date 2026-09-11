import { describe, expect, it } from 'vitest';

import {
  isMedianEligibleSource,
  medianOf,
  resolveDurationAxis,
  summarizeDurationDistribution,
  toAxisPercent,
} from './duration-distribution';

describe('isMedianEligibleSource', () => {
  it('auto_migrated だけを中央値から除く', () => {
    expect(isMedianEligibleSource('manual')).toBe(true);
    expect(isMedianEligibleSource('from_plan')).toBe(true);
    expect(isMedianEligibleSource('auto_migrated')).toBe(false);
  });
});

describe('medianOf', () => {
  it('奇数件は中央の値、偶数件は中央 2 件の平均', () => {
    expect(medianOf([30, 10, 20])).toBe(20);
    expect(medianOf([40, 10, 30, 20])).toBe(25);
  });

  it('0 件は null（0 ではない）', () => {
    expect(medianOf([])).toBeNull();
  });
});

describe('summarizeDurationDistribution', () => {
  it('3 件未満は null を返す（沈黙）', () => {
    expect(summarizeDurationDistribution([])).toBeNull();
    expect(summarizeDurationDistribution([30])).toBeNull();
    expect(summarizeDurationDistribution([30, 60])).toBeNull();
  });

  it('奇数件は中央値を除いた上下半分の中央値を四分位にする', () => {
    const distribution = summarizeDurationDistribution([1, 2, 3, 4, 5]);

    expect(distribution).toEqual({ n: 5, min: 1, q1: 1.5, median: 3, q3: 4.5, max: 5 });
  });

  it('偶数件は上下半分をそのまま二分する', () => {
    const distribution = summarizeDurationDistribution([1, 2, 3, 4]);

    expect(distribution).toEqual({ n: 4, min: 1, q1: 1.5, median: 2.5, q3: 3.5, max: 4 });
  });

  it('入力の並び順に依存しない', () => {
    expect(summarizeDurationDistribution([5, 1, 4, 2, 3])).toEqual(
      summarizeDurationDistribution([1, 2, 3, 4, 5]),
    );
  });

  it('全件同じ長さでも分布を返す', () => {
    expect(summarizeDurationDistribution([60, 60, 60])).toEqual({
      n: 3,
      min: 60,
      q1: 60,
      median: 60,
      q3: 60,
      max: 60,
    });
  });
});

describe('resolveDurationAxis', () => {
  const distribution = summarizeDurationDistribution([30, 60, 90])!;

  it('予定の中央値が無ければ記録の min–max を軸にする', () => {
    expect(resolveDurationAxis(distribution, null)).toEqual({ min: 30, max: 90 });
  });

  it('予定の中央値が外側にあれば軸を広げる', () => {
    expect(resolveDurationAxis(distribution, 120)).toEqual({ min: 30, max: 120 });
    expect(resolveDurationAxis(distribution, 10)).toEqual({ min: 10, max: 90 });
  });

  it('予定の中央値が内側なら軸は変わらない', () => {
    expect(resolveDurationAxis(distribution, 45)).toEqual({ min: 30, max: 90 });
  });
});

describe('toAxisPercent', () => {
  it('軸の min を 0%、max を 100% に写す', () => {
    const axis = { min: 30, max: 90 };

    expect(toAxisPercent(30, axis)).toBe(0);
    expect(toAxisPercent(60, axis)).toBe(50);
    expect(toAxisPercent(90, axis)).toBe(100);
  });

  it('幅ゼロの軸は 50% に置く', () => {
    expect(toAxisPercent(60, { min: 60, max: 60 })).toBe(50);
  });

  it('軸の外の値は 0–100 に収める', () => {
    const axis = { min: 30, max: 90 };

    expect(toAxisPercent(10, axis)).toBe(0);
    expect(toAxisPercent(200, axis)).toBe(100);
  });
});
