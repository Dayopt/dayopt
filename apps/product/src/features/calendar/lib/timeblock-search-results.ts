export type TimeblockSearchResultKind = 'plan' | 'record';

/** Search UI が plans.list / records.list から使う最小行 shape。 */
export interface TimeblockSearchSourceRow {
  id: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
}

/** Plan / Record を区別したブロック検索結果。 */
export interface TimeblockSearchResult {
  kind: TimeblockSearchResultKind;
  id: string;
  note: string | null;
  activityId: string | null;
  startAt: string;
  endAt: string;
}

interface MergedTimeblockSearchResults {
  results: TimeblockSearchResult[];
  hasMore: boolean;
}

function toSearchResult(
  row: TimeblockSearchSourceRow,
  kind: TimeblockSearchResultKind,
): TimeblockSearchResult {
  return {
    kind,
    id: row.id,
    note: row.note,
    activityId: row.activity_id,
    startAt: row.start_at,
    endAt: row.end_at,
  };
}

/** Plan / Record を安定した開始日時降順へ統合し、表示上限を適用する。 */
export function mergeTimeblockSearchResults(
  plans: readonly TimeblockSearchSourceRow[],
  records: readonly TimeblockSearchSourceRow[],
  limit = 20,
): MergedTimeblockSearchResults {
  const indexedResults = [
    ...plans.map((row) => toSearchResult(row, 'plan')),
    ...records.map((row) => toSearchResult(row, 'record')),
  ].map((result, index) => ({ result, index }));

  indexedResults.sort((a, b) => {
    const startDifference = Date.parse(b.result.startAt) - Date.parse(a.result.startAt);
    return Number.isNaN(startDifference) || startDifference === 0
      ? a.index - b.index
      : startDifference;
  });

  const normalizedLimit = Math.max(0, limit);
  return {
    results: indexedResults.slice(0, normalizedLimit).map(({ result }) => result),
    hasMore: indexedResults.length > normalizedLimit,
  };
}
