import { describe, expect, it } from 'vitest';

import { hasTwoLayerTimeConflict, rangesOverlap } from './time-conflict';

const start = '2026-09-29T09:00:00Z';
const end = '2026-09-29T10:00:00Z';

describe('overlap input boundaries', () => {
  it.each([null, undefined, 'invalid', new Date(Number.NaN)])(
    'rejects each missing or invalid endpoint independently: %s',
    (invalid) => {
      // 守ること: 片端だけの欠損を epoch 0 として解釈し、重複扱いしない。
      expect(rangesOverlap(invalid, end, start, end)).toBe(false);
      expect(rangesOverlap(start, invalid, start, end)).toBe(false);
      expect(rangesOverlap(start, end, invalid, end)).toBe(false);
      expect(rangesOverlap(start, end, start, invalid)).toBe(false);
    },
  );

  it('detects intersection but allows touching half-open endpoints', () => {
    // 守ること: 重複は検出し、半開区間の接点だけでは競合にしない。
    expect(rangesOverlap(start, end, start, end)).toBe(true);
    expect(rangesOverlap(start, end, end, '2026-09-29T11:00:00Z')).toBe(false);
  });

  it('rejects incomplete ranges even when there are no existing timeblocks', () => {
    // 守ること: 既存データが空でも片端のない作成要求を拒否する。
    expect(hasTwoLayerTimeConflict([], { plannedStart: start })).toBe(true);
    expect(hasTwoLayerTimeConflict([], { actualEnd: end })).toBe(true);
    expect(hasTwoLayerTimeConflict([], { plannedStart: start, plannedEnd: end })).toBe(false);
  });
});
