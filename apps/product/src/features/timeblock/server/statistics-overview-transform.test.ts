import { describe, expect, it } from 'vitest';

import {
  type StatsKpiSummaryRpcResult,
  transformStatsOverviewResponse,
} from './statistics-overview-transform';

function makeFullResult(
  overrides: Partial<StatsKpiSummaryRpcResult> = {},
): StatsKpiSummaryRpcResult {
  return {
    cumulativeTime: { totalMinutes: 600 },
    planRate: { totalEntries: 30, plannedEntries: 25, planRate: 0.83 },
    contextSwitches: { totalSwitches: 12, avgPerDay: 1.5 },
    blankRate: {
      availableMinutes: 480,
      scheduledMinutes: 360,
      blankMinutes: 120,
      blankRate: 0.25,
    },
    ...overrides,
  };
}

describe('transformStatsOverviewResponse', () => {
  it('null 入力 → 全 field が default', () => {
    expect(transformStatsOverviewResponse(null)).toEqual({
      cumulativeTime: { totalMinutes: 0 },
      planRate: { totalEntries: 0, plannedEntries: 0, planRate: null },
      contextSwitches: { totalSwitches: 0, avgPerDay: 0 },
      blankRate: {
        availableMinutes: 0,
        scheduledMinutes: 0,
        blankMinutes: 0,
        blankRate: 0,
      },
    });
  });

  it('undefined 入力 → 全 field が default', () => {
    const result = transformStatsOverviewResponse(undefined);
    expect(result.cumulativeTime.totalMinutes).toBe(0);
    expect(result.planRate.totalEntries).toBe(0);
  });

  it('完全な response → そのまま受け渡し + planRate → planRate rename', () => {
    const result = transformStatsOverviewResponse(makeFullResult());
    expect(result).toEqual({
      cumulativeTime: { totalMinutes: 600 },
      planRate: { totalEntries: 30, plannedEntries: 25, planRate: 0.83 },
      contextSwitches: { totalSwitches: 12, avgPerDay: 1.5 },
      blankRate: {
        availableMinutes: 480,
        scheduledMinutes: 360,
        blankMinutes: 120,
        blankRate: 0.25,
      },
    });
  });

  it('overview の KPI key は planRate に統一する', () => {
    const result = transformStatsOverviewResponse(makeFullResult());
    expect('planRate' in result).toBe(true);
    expect('entryRate' in result).toBe(false);
  });

  it('部分的 response: cumulativeTime のみ missing → そこだけ 0、他は値保持', () => {
    const partial = makeFullResult();
    // @ts-expect-error: 部分的に削除した状態を模倣
    delete partial.cumulativeTime;
    const result = transformStatsOverviewResponse(partial);
    expect(result.cumulativeTime.totalMinutes).toBe(0);
    expect(result.planRate.totalEntries).toBe(30);
  });

  it('planRate.planRate が実値 0 → そのまま 0 (default と区別される)', () => {
    const result = transformStatsOverviewResponse({
      planRate: { totalEntries: 0, plannedEntries: 0, planRate: null },
    });
    expect(result.planRate.planRate).toBeNull();
    expect(result.planRate.totalEntries).toBe(0);
  });

  it('全 nested が undefined → 全 field default', () => {
    const result = transformStatsOverviewResponse({});
    expect(result.cumulativeTime.totalMinutes).toBe(0);
    expect(result.planRate.totalEntries).toBe(0);
    expect(result.contextSwitches.totalSwitches).toBe(0);
    expect(result.blankRate.blankRate).toBe(0);
  });

  it('blankRate のみ完全 → 他は default', () => {
    const result = transformStatsOverviewResponse({
      blankRate: {
        availableMinutes: 480,
        scheduledMinutes: 360,
        blankMinutes: 120,
        blankRate: 0.25,
      },
    });
    expect(result.blankRate).toEqual({
      availableMinutes: 480,
      scheduledMinutes: 360,
      blankMinutes: 120,
      blankRate: 0.25,
    });
    expect(result.cumulativeTime.totalMinutes).toBe(0);
  });
});
