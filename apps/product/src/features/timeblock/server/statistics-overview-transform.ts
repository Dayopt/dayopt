/**
 * `getStatsOverview` procedure の RPC response unpacking。
 *
 * RPC `get_stats_kpi_summary` の nested response wrapper を tRPC stable
 * response shape に変換する server-side adapter。
 *
 * 各 KPI の inner unpack は `./statistics-kpi-unpackers` に集約しており、
 * 個別 KPI procedure (`get_cumulative_time` 等) と共通の default / rename ロジックを共有する。
 */

import {
  type BlankRateRpcInner,
  type ContextSwitchesRpcInner,
  type CumulativeTimeRpcInner,
  type PlanRateRpcInner,
  unpackBlankRate,
  unpackContextSwitches,
  unpackCumulativeTime,
  unpackPlanRate,
} from './statistics-kpi-unpackers';

/** RPC `get_stats_kpi_summary` が返す nested response shape */
export interface StatsKpiSummaryRpcResult {
  cumulativeTime: CumulativeTimeRpcInner;
  planRate: PlanRateRpcInner;
  contextSwitches: ContextSwitchesRpcInner;
  blankRate: BlankRateRpcInner;
}

/**
 * tRPC response shape。
 *
 * missing field は 0 にフォールバックされる。
 */
interface StatsOverviewResult {
  cumulativeTime: { totalMinutes: number };
  planRate: { totalEntries: number; plannedEntries: number; planRate: number | null };
  contextSwitches: { totalSwitches: number; avgPerDay: number };
  blankRate: {
    availableMinutes: number;
    scheduledMinutes: number;
    blankMinutes: number;
    blankRate: number;
  };
}

/**
 * RPC `get_stats_kpi_summary` の戻り値を tRPC response shape に変換する。
 *
 * - `null` / `undefined` 入力でも全 field を default で埋めた応答を返す
 * - `planRate` は `unpackPlanRate` で default 埋めする
 * - その他の missing field は `?? 0`
 */
export function transformStatsOverviewResponse(data: unknown): StatsOverviewResult {
  const result = data as Partial<StatsKpiSummaryRpcResult> | null | undefined;
  return {
    cumulativeTime: unpackCumulativeTime(result?.cumulativeTime),
    planRate: unpackPlanRate(result?.planRate),
    contextSwitches: unpackContextSwitches(result?.contextSwitches),
    blankRate: unpackBlankRate(result?.blankRate),
  };
}
