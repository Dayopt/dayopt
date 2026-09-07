/**
 * 単一 KPI の RPC response unpacker。
 *
 * 各 unpacker は `unknown` を受け取り、その KPI の sub-shape を `?.` + `?? default`
 * で安全に unpack する。以下 2 種類の呼び出し元から共通利用される:
 *
 * 1. 個別 KPI procedure: `get_cumulative_time` / `get_plan_rate` /
 *    `get_context_switches` / `get_blank_rate` の各 RPC が
 *    返す flat な inner shape をそのまま unpack
 * 2. `transformStatsOverviewResponse`: `get_stats_kpi_summary` RPC が返す
 *    nested wrapper から `wrapper?.<kpi>` を取り出して同じ unpacker に渡す
 *
 * このように両者で同じ default 値・rename ロジックを共有することで、
 * `getStatsOverview` と個別 KPI endpoint で挙動が乖離しないことを保証する。
 */

/** `unpackCumulativeTime` の入力 inner shape */
export interface CumulativeTimeRpcInner {
  totalMinutes: number;
}

/** `unpackPlanRate` の入力 inner shape */
export interface PlanRateRpcInner {
  totalEntries: number;
  plannedEntries: number;
  planRate: number | null;
}

/** `unpackContextSwitches` の入力 inner shape */
export interface ContextSwitchesRpcInner {
  totalSwitches: number;
  avgPerDay: number;
}

/** `unpackBlankRate` の入力 inner shape */
export interface BlankRateRpcInner {
  availableMinutes: number;
  scheduledMinutes: number;
  blankMinutes: number;
  blankRate: number;
}

/** 累計時間 KPI を default 埋めして unpack */
export function unpackCumulativeTime(data: unknown): { totalMinutes: number } {
  const result = data as Partial<CumulativeTimeRpcInner> | null | undefined;
  return { totalMinutes: result?.totalMinutes ?? 0 };
}

/**
 * 計画率 KPI を default 埋めして unpack。
 */
export function unpackPlanRate(data: unknown): {
  totalEntries: number;
  plannedEntries: number;
  planRate: number | null;
} {
  const result = data as Partial<PlanRateRpcInner> | null | undefined;
  return {
    totalEntries: result?.totalEntries ?? 0,
    plannedEntries: result?.plannedEntries ?? 0,
    planRate: result?.planRate ?? null,
  };
}

/** コンテキストスイッチ KPI を default 埋めして unpack */
export function unpackContextSwitches(data: unknown): {
  totalSwitches: number;
  avgPerDay: number;
} {
  const result = data as Partial<ContextSwitchesRpcInner> | null | undefined;
  return {
    totalSwitches: result?.totalSwitches ?? 0,
    avgPerDay: result?.avgPerDay ?? 0,
  };
}

/** 空白率 KPI を default 埋めして unpack */
export function unpackBlankRate(data: unknown): {
  availableMinutes: number;
  scheduledMinutes: number;
  blankMinutes: number;
  blankRate: number;
} {
  const result = data as Partial<BlankRateRpcInner> | null | undefined;
  return {
    availableMinutes: result?.availableMinutes ?? 0,
    scheduledMinutes: result?.scheduledMinutes ?? 0,
    blankMinutes: result?.blankMinutes ?? 0,
    blankRate: result?.blankRate ?? 0,
  };
}
