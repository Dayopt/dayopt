/**
 * タグ完全削除の確認判定で使う「影響を受ける件数」の算出。
 *
 * `api.statistics.getActivityStats` は records の実績件数（`counts`）と Plan の件数
 * （`planCounts`）を別々に返す。タグ削除は `ON DELETE SET NULL` で Plan / Record
 * 両方を未分類化するため、削除判定・確認ダイアログの件数は両方の合計が必要
 * （#1576 フォローアップ: Plan のみ・Record 0 件のタグが 0 件と誤判定され、
 * 確認ダイアログなしで即削除されてしまう不具合の修正）。
 *
 * `counts`（records のみ）自体は変更しない。実績件数としての意味を保つため、
 * 表示用途で使う場合は引き続き `stats.counts` を直接参照する。
 */

interface ActivityStatsForDeleteCount {
  counts: Record<string, number>;
  planCounts: Record<string, number>;
}

/**
 * records + plans の合計件数を activityId ごとに算出する。
 *
 * @param stats - `api.statistics.getActivityStats` の結果。取得前は undefined
 * @param isError - 取得エラー時は集計不能なため、呼び出し側で安全側（常に確認ダイアログ）に倒す
 * @returns activityId → 合計件数の Record。未取得・エラー時は null
 */
export function mergeActivityDeleteCounts(
  stats: ActivityStatsForDeleteCount | undefined,
  isError: boolean,
): Record<string, number> | null {
  if (isError || !stats) return null;

  const recordCounts = stats?.counts ?? {};
  const planCounts = stats?.planCounts ?? {};

  const merged: Record<string, number> = { ...recordCounts };
  for (const activityId of Object.keys(planCounts)) {
    merged[activityId] = (merged[activityId] ?? 0) + (planCounts[activityId] ?? 0);
  }
  return merged;
}
