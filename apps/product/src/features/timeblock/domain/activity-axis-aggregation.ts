/**
 * アクティビティ軸の集計（#2162 の 3 構造モデル）。
 *
 * アクティビティは**分割**の軸（1 ブロックは 1 アクティビティにしか属さない）なので、
 * 次の不変条件が成立する。これが「集計が濁らない」の実体になる:
 *
 * ```
 * Σ(各アクティビティの時間) + アクティビティなし = 対象期間の全ブロック時間
 * ```
 *
 * カテゴリー軸とセグメント軸の集計もここにあったが、唯一の consumer だった旧レポートの
 * Time P/L とセグメント合計を撤去したので落とした（#2583）。新レポートはこれらの派生を
 * 現在このモジュールを使うのは MCP の `review.get`（`time-pl-review.ts` 経由）だけ。
 */

/** 集計対象の 1 ブロック（Plan または Record）。 */
export interface ActivityAxisDurationRow {
  /** アクティビティ未設定のブロックは null */
  activityId: string | null;
  minutes: number;
}

/** アクティビティ軸の 1 行。`activityId: null` は「アクティビティなし」。 */
interface ActivityAxisAggregate {
  activityId: string | null;
  plannedMinutes: number;
  recordedMinutes: number;
  hasPlan: boolean;
  hasRecord: boolean;
}

interface AxisAccumulator {
  plannedMinutes: number;
  recordedMinutes: number;
  hasPlan: boolean;
  hasRecord: boolean;
}

/**
 * Plan / Record duration をアクティビティ別に加算する。
 *
 * `activityId` が null の行（アクティビティ未設定、およびアクティビティ削除で
 * `activity_id = NULL` になった行）は単一の「アクティビティなし」バケットへ畳む。
 * 落とさずに畳むことで、上記の不変条件が成立する。
 */
export function aggregateByActivity(
  plans: ReadonlyArray<ActivityAxisDurationRow>,
  records: ReadonlyArray<ActivityAxisDurationRow>,
): ActivityAxisAggregate[] {
  const totals = new Map<string | null, AxisAccumulator>();
  accumulate(totals, plans, (row) => row.activityId, 'plannedMinutes', 'hasPlan');
  accumulate(totals, records, (row) => row.activityId, 'recordedMinutes', 'hasRecord');

  return Array.from(totals.entries()).map(([activityId, acc]) => ({
    activityId,
    plannedMinutes: roundToTenth(acc.plannedMinutes),
    recordedMinutes: roundToTenth(acc.recordedMinutes),
    hasPlan: acc.hasPlan,
    hasRecord: acc.hasRecord,
  }));
}

function accumulate(
  totals: Map<string | null, AxisAccumulator>,
  rows: ReadonlyArray<ActivityAxisDurationRow>,
  resolveKey: (row: ActivityAxisDurationRow) => string | null,
  minutesField: 'plannedMinutes' | 'recordedMinutes',
  presenceField: 'hasPlan' | 'hasRecord',
): void {
  for (const row of rows) {
    const key = resolveKey(row);
    const acc = totals.get(key) ?? {
      plannedMinutes: 0,
      recordedMinutes: 0,
      hasPlan: false,
      hasRecord: false,
    };
    acc[minutesField] += row.minutes;
    acc[presenceField] = true;
    totals.set(key, acc);
  }
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
