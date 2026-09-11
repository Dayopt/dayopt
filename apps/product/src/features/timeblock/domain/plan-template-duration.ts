/**
 * テンプレート（型）適用時に各ブロックへ「着せる」長さの pure aggregation（#2567）。
 *
 * 型は寸法を持たない（v1.0 §5.4）。適用時に activity 別の**実績（Record）の実時間の中央値**を
 * 着る。`activity-estimation-factor.ts`（実績 ÷ 予定の比率）とは別物 — 型には掛け算元の
 * 予定時間が無いので、比率ではなく分そのものを集計する。流用するのは規約だけ:
 *
 * - 直近 4 週（期間の切り出しは fetcher 側）
 * - 中央値（平均は 1 回の大事故に引きずられる）
 * - `n >= 3` 未満は沈黙（根拠の薄い数字を出さない）。既定長は呼び出し側が
 *   `user_settings.default_duration` を渡す
 * - 5 分丸め
 * - `source = 'auto_migrated'` の Record は除外（ユーザーが確定した実績ではない）
 *
 * 同じ集計を `statistics.getActivityStats` の `medianMinutes` も使う（作成パネルの
 * アクティビティ pill の目安表示と、サイドバータップの既定長）。定義を 2 本にしない。
 */

/** 集計対象の Record 行。期間フィルタ適用後のものを渡す。 */
export interface TemplateDurationRecordRow {
  activity_id: string | null;
  source: string;
  start_at: string;
  end_at: string;
}

/** 中央値の窓（日）。`activity-estimation-factor` の「直近 4 週」と揃える。 */
export const MEDIAN_DURATION_WINDOW_DAYS = 28;

/** 沈黙閾値。これ未満の activity は中央値を返さず既定長になる。 */
const MIN_TEMPLATE_DURATION_SAMPLE_COUNT = 3;

/** 丸め単位（分）。 */
const TEMPLATE_DURATION_STEP_MINUTES = 5;

/** ブロック 1 つの最短（これ未満に clip されるなら適用全体を拒否する）。 */
export const MIN_TEMPLATE_BLOCK_MINUTES = 5;

/** 異常に長い Record（つけっぱなし等）で日を越えないための上限。 */
export const MAX_TEMPLATE_BLOCK_MINUTES = 8 * 60;

const AUTO_MIGRATED_SOURCE = 'auto_migrated';

/** 偶数件は中央 2 件の平均。入力は昇順ソート済みであること。 */
function median(sortedValues: readonly number[]): number {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle] as number;
  return ((sortedValues[middle - 1] as number) + (sortedValues[middle] as number)) / 2;
}

/** 5 分刻みへ丸め、[MIN, MAX] に収める。 */
export function normalizeTemplateBlockMinutes(minutes: number): number {
  const rounded =
    Math.round(minutes / TEMPLATE_DURATION_STEP_MINUTES) * TEMPLATE_DURATION_STEP_MINUTES;
  return Math.min(MAX_TEMPLATE_BLOCK_MINUTES, Math.max(MIN_TEMPLATE_BLOCK_MINUTES, rounded));
}

/**
 * activity 別の実時間中央値（分）。`n >= 3` の activity だけが Map に入る。
 *
 * 除外: `activity_id` が無い / `auto_migrated` / 長さが 0 以下。
 */
export function aggregateActivityMedianDurations(
  records: ReadonlyArray<TemplateDurationRecordRow>,
): Map<string, number> {
  const minutesByActivity = new Map<string, number[]>();
  for (const record of records) {
    if (record.activity_id == null || record.source === AUTO_MIGRATED_SOURCE) continue;
    const minutes = (Date.parse(record.end_at) - Date.parse(record.start_at)) / 60_000;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const bucket = minutesByActivity.get(record.activity_id) ?? [];
    bucket.push(minutes);
    minutesByActivity.set(record.activity_id, bucket);
  }

  const result = new Map<string, number>();
  for (const [activityId, minutes] of minutesByActivity) {
    if (minutes.length < MIN_TEMPLATE_DURATION_SAMPLE_COUNT) continue;
    result.set(
      activityId,
      normalizeTemplateBlockMinutes(median([...minutes].sort((a, b) => a - b))),
    );
  }
  return result;
}
