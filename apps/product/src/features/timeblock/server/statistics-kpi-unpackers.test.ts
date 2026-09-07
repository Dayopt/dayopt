import { describe, expect, it } from 'vitest';

import {
  unpackBlankRate,
  unpackContextSwitches,
  unpackCumulativeTime,
  unpackPlanRate,
} from './statistics-kpi-unpackers';

describe('unpackCumulativeTime', () => {
  it('null → totalMinutes: 0', () => {
    expect(unpackCumulativeTime(null)).toEqual({ totalMinutes: 0 });
  });

  it('undefined → totalMinutes: 0', () => {
    expect(unpackCumulativeTime(undefined)).toEqual({ totalMinutes: 0 });
  });

  it('値あり → そのまま受け渡し', () => {
    expect(unpackCumulativeTime({ totalMinutes: 600 })).toEqual({ totalMinutes: 600 });
  });

  it('実値 0 → default と区別される (そのまま 0)', () => {
    expect(unpackCumulativeTime({ totalMinutes: 0 })).toEqual({ totalMinutes: 0 });
  });
});

describe('unpackPlanRate', () => {
  it('null → 全 default (0)', () => {
    expect(unpackPlanRate(null)).toEqual({
      totalEntries: 0,
      plannedEntries: 0,
      planRate: null,
    });
  });

  it('planRate → planRate に rename される', () => {
    expect(unpackPlanRate({ totalEntries: 30, plannedEntries: 25, planRate: 0.83 })).toEqual({
      totalEntries: 30,
      plannedEntries: 25,
      planRate: 0.83,
    });
  });

  it('output は planRate field に統一する', () => {
    const result = unpackPlanRate({ totalEntries: 30, plannedEntries: 25, planRate: 0.83 });
    expect('planRate' in result).toBe(true);
    expect('entryRate' in result).toBe(false);
  });

  it('実値 0 → default と区別される', () => {
    expect(unpackPlanRate({ totalEntries: 0, plannedEntries: 0, planRate: null })).toEqual({
      totalEntries: 0,
      plannedEntries: 0,
      planRate: null,
    });
  });
});

describe('unpackContextSwitches', () => {
  it('null → 全 0', () => {
    expect(unpackContextSwitches(null)).toEqual({ totalSwitches: 0, avgPerDay: 0 });
  });

  it('値あり → そのまま受け渡し', () => {
    expect(unpackContextSwitches({ totalSwitches: 12, avgPerDay: 1.5 })).toEqual({
      totalSwitches: 12,
      avgPerDay: 1.5,
    });
  });

  it('部分: totalSwitches のみ → avgPerDay は 0', () => {
    expect(unpackContextSwitches({ totalSwitches: 5 })).toEqual({
      totalSwitches: 5,
      avgPerDay: 0,
    });
  });
});

describe('unpackBlankRate', () => {
  it('null → 全 0', () => {
    expect(unpackBlankRate(null)).toEqual({
      availableMinutes: 0,
      scheduledMinutes: 0,
      blankMinutes: 0,
      blankRate: 0,
    });
  });

  it('値あり → そのまま受け渡し', () => {
    expect(
      unpackBlankRate({
        availableMinutes: 480,
        scheduledMinutes: 360,
        blankMinutes: 120,
        blankRate: 0.25,
      }),
    ).toEqual({
      availableMinutes: 480,
      scheduledMinutes: 360,
      blankMinutes: 120,
      blankRate: 0.25,
    });
  });

  it('部分: blankRate のみ → 他は 0', () => {
    expect(unpackBlankRate({ blankRate: 0.5 })).toEqual({
      availableMinutes: 0,
      scheduledMinutes: 0,
      blankMinutes: 0,
      blankRate: 0.5,
    });
  });

  it('undefined → 全 0', () => {
    expect(unpackBlankRate(undefined)).toEqual({
      availableMinutes: 0,
      scheduledMinutes: 0,
      blankMinutes: 0,
      blankRate: 0,
    });
  });
});
