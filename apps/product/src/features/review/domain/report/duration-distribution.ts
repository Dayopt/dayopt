/**
 * 「1 件あたりの長さ」の分布（詳細パネルのストリップ）。
 *
 * **平均を出さない**（仕様 §0）。代表値は中央値、幅は四分位で語る。閾値未満は数字を作らず
 * 沈黙する（`STRIP_MIN_RECORDS`）。
 *
 * **`auto_migrated` の Record は中央値系から除く。** ユーザーが確定した実績ではないため、
 * 作成パネルの「普段の長さ」（`features/timeblock/domain/plan-template-duration.ts`）と
 * 同じ規則にする。合計・充実・時間帯・明細は事実なので全件のまま数える。定数を feature 間で
 * import せず同値を別に持つのは、依存方向（`features/` 同士の deep import 禁止）のため。
 */

/** ストリップを出す最小件数。これ未満は分布と呼べないので節ごと沈黙する。 */
const STRIP_MIN_RECORDS = 3;

/** 自動移行で作られた Record の `source`。ユーザーが確定した実績ではない。 */
const AUTO_MIGRATED_RECORD_SOURCE = 'auto_migrated';

/** 中央値・四分位に数えてよい Record か。 */
export function isMedianEligibleSource(source: string): boolean {
  return source !== AUTO_MIGRATED_RECORD_SOURCE;
}

/**
 * 昇順の値列の中央値。偶数件は中央 2 件の平均（`lib/time` の `aggregate` と同じ規則）。
 *
 * 空配列は `null`（0 ではない。「0 分だった」と読めてしまう）。
 */
function medianOfSorted(sortedValues: readonly number[]): number | null {
  if (sortedValues.length === 0) return null;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle]!;
  return (sortedValues[middle - 1]! + sortedValues[middle]!) / 2;
}

/** ソート済みでない値列の中央値。 */
export function medianOf(values: readonly number[]): number | null {
  return medianOfSorted([...values].sort((a, b) => a - b));
}

interface DurationDistribution {
  /** 分布に使った件数。 */
  n: number;
  min: number;
  /** 25%。中央値を除いた下半分の中央値。 */
  q1: number;
  median: number;
  /** 75%。中央値を除いた上半分の中央値。 */
  q3: number;
  max: number;
}

/**
 * 長さ（分）の分布。`STRIP_MIN_RECORDS` 未満は `null`（沈黙）。
 *
 * 四分位は **Tukey の hinge**（奇数件は中央値を両半分から除く）。方式を 1 つに決めておかないと、
 * 帯の端が実装ごとに動いて「同じデータなのに違う幅」に見える。
 */
export function summarizeDurationDistribution(
  values: readonly number[],
): DurationDistribution | null {
  if (values.length < STRIP_MIN_RECORDS) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted.slice(0, middle);
  // 奇数件は中央の 1 件を上半分からも除く
  const upper = sorted.slice(sorted.length % 2 === 1 ? middle + 1 : middle);

  return {
    n: sorted.length,
    min: sorted[0]!,
    q1: medianOfSorted(lower)!,
    median: medianOfSorted(sorted)!,
    q3: medianOfSorted(upper)!,
    max: sorted[sorted.length - 1]!,
  };
}

interface DurationAxis {
  min: number;
  max: number;
}

/**
 * ストリップの軸。記録の min–max を端にする。
 *
 * **予定の中央値が外側にあれば軸を広げる。** 軸へ clamp すると「予定はちょうど最長と同じ」と
 * 読めてしまい、実際より近く見える。
 */
export function resolveDurationAxis(
  distribution: DurationDistribution,
  planMedianMinutes: number | null,
): DurationAxis {
  if (planMedianMinutes === null) return { min: distribution.min, max: distribution.max };
  return {
    min: Math.min(distribution.min, planMedianMinutes),
    max: Math.max(distribution.max, planMedianMinutes),
  };
}

/**
 * 軸上の位置（0–100）。全件同じ長さ（幅ゼロの軸）は 50 に置く。
 *
 * 軸の外の値も clamp して 0–100 に収める（描画が枠外へ飛ばないように）。
 */
export function toAxisPercent(value: number, axis: DurationAxis): number {
  const span = axis.max - axis.min;
  if (!(span > 0)) return 50;
  const ratio = (value - axis.min) / span;
  return Math.min(100, Math.max(0, ratio * 100));
}
