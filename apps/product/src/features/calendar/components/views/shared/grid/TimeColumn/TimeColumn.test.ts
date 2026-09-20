import { describe, expect, it } from 'vitest';

import { isHourLabelOccluded } from './TimeColumn';

describe('isHourLabelOccluded', () => {
  it('現在時刻バッジが乗る時刻ラベルだけを隠す', () => {
    // 08:42 のバッジ（hourHeight 72px → 24px は 20 分）
    expect(isHourLabelOccluded(9, 8 * 60 + 42, 72)).toBe(true);
    expect(isHourLabelOccluded(8, 8 * 60 + 42, 72)).toBe(false);
    expect(isHourLabelOccluded(10, 8 * 60 + 42, 72)).toBe(false);
  });

  it('ちょうど :00 のバッジは同じ時刻のラベルを隠す', () => {
    expect(isHourLabelOccluded(9, 9 * 60, 72)).toBe(true);
  });

  it('hourHeight が小さいほど広い範囲のラベルを隠す', () => {
    // 36px/h では 24px = 40 分。08:25 のバッジは 09:00 まで届く
    expect(isHourLabelOccluded(9, 8 * 60 + 25, 36)).toBe(true);
    expect(isHourLabelOccluded(9, 8 * 60 + 25, 72)).toBe(false);
  });

  it('バッジが無い（null / undefined）時は隠さない', () => {
    expect(isHourLabelOccluded(9, null, 72)).toBe(false);
    expect(isHourLabelOccluded(9, undefined, 72)).toBe(false);
  });
});
