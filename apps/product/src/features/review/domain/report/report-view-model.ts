/**
 * レポート 1〜4 章の派生（client 側の純粋関数）。
 *
 * サーバーはアクティビティ別のスカラーだけを返し、フィルタ・分母・鏡・羅針盤は
 * すべてここで導出する。カテゴリのトグルや余白の on/off でサーバーへ往復させないため。
 *
 * **評価しない。** スコア・達成率・平均・ストリーク・良し悪しの判定はここに置かない
 * （仕様 §0-2 / §12）。閾値未満は数字を作らず沈黙する。
 */

import type { ReportActivityAggregate } from '../../server/report-aggregation-service';

// ============================================================
// 閾値（仕様 付録A）
// ============================================================

/**
 * 羅針盤に点が生まれる充実の回答数。これ未満は待機リストへ。
 */
export const COMPASS_MIN_FULFILLMENT = 5;
/**
 * 見積もりの鏡の候補になる過去予定の箱数。
 */
export const MIRROR_MIN_PLAN_BOXES = 3;
/**
 * 見積もりの鏡の候補になる過去予定の分数。
 */
export const MIRROR_MIN_PLAN_MINUTES = 30;
/**
 * 予定比を出す最小の過去予定分数。これ未満は比率を作らない。
 */
export const EXECUTION_MIN_PLAN_MINUTES = 15;
/**
 * 見積もりの鏡に出す最大件数。
 */
const MIRROR_MAX_ROWS = 3;

// ============================================================
// フィルタ
// ============================================================

/**
 * 期間集計を、今のコードが前提にする形へ寄せる。
 *
 * **集計はブラウザに永続化される**（`PersistQueryClientProvider`、`getReportPeriod` も対象）。
 * 捨てる目印（cache buster）は本番がリリース版数、dev が固定値なので、項目を足す変更が
 * リリースの間にデプロイされると、足す前に保存された形がそのまま復元されて描画で落ちる
 * （`durationCounts` を回そうとして `list is not iterable`）。取り直すまでの一瞬でも面ごと
 * 消えるので、足りない項目は「無い」として空で補う。
 *
 * 項目を足す時はここにも既定値を足す。
 */
export function normalizeReportPeriodPayload<
  TPayload extends {
    activities: readonly LegacyReportActivity[];
    previousActivities: readonly LegacyPreviousActivity[];
  },
>(
  payload: TPayload,
): Omit<TPayload, 'activities' | 'previousActivities'> & {
  activities: ReportActivityAggregate[];
  previousActivities: PreviousAggregate[];
} {
  return {
    ...payload,
    activities: payload.activities.map((activity) => ({
      ...activity,
      durationCounts: Array.isArray(activity.durationCounts) ? activity.durationCounts : [],
      byHour: Array.isArray(activity.byHour) ? activity.byHour : [],
    })),
    previousActivities: payload.previousActivities.map((row) => ({
      ...row,
      recordBoxes: typeof row.recordBoxes === 'number' ? row.recordBoxes : 0,
      durationCounts: Array.isArray(row.durationCounts) ? row.durationCounts : [],
    })),
  };
}

/** 項目を足す前に保存されたかもしれない集計行。足した項目は省略されうる。 */
type LegacyReportActivity = Omit<ReportActivityAggregate, 'durationCounts' | 'byHour'> &
  Partial<Pick<ReportActivityAggregate, 'durationCounts' | 'byHour'>>;

type LegacyPreviousActivity = {
  activityId: string | null;
  recordedMinutes: number;
  recordBoxes?: number | undefined;
  durationCounts?: [number, number][] | undefined;
};

/** 未分類（カテゴリー未設定）を表す擬似カテゴリのキー。 */
export const UNCATEGORIZED_KEY = '__uncategorized';

export interface ReportFilterState {
  /** ここに載っていないカテゴリは可視。新しく作ったカテゴリが自動で可視になる。 */
  hiddenCategoryIds: readonly string[];
  /**
   * ここに載っていないアクティビティは可視。カテゴリーと同じ hidden 方式で、
   * 新しく作ったアクティビティが自動で分母に入る。
   */
  hiddenActivityIds: readonly string[];
}

export const defaultReportFilterState: ReportFilterState = {
  hiddenCategoryIds: [],
  hiddenActivityIds: [],
};

/**
 * 分母に入れるアクティビティを絞る（仕様の `visA`）。
 *
 * カテゴリーとアクティビティの両方の hidden を通す（親が隠れていれば子も出ない）。
 * 未分類のアクティビティ（カテゴリー未設定）はアクティビティ単位でだけ出し入れする。
 *
 * **アクティビティ未設定の行は常に残す**（カレンダーと同じ。フィルタ行を持たず、
 * すべての集計に含める = activities 仕様「アクティビティなし」）。
 */
export function resolveVisibleActivities(
  activities: readonly ReportActivityAggregate[],
  filter: ReportFilterState,
): ReportActivityAggregate[] {
  const hiddenCategories = new Set(filter.hiddenCategoryIds);
  const hiddenActivities = new Set(filter.hiddenActivityIds);
  return activities.filter((activity) => {
    if (activity.activityId === null) return true;
    if (hiddenActivities.has(activity.activityId)) return false;
    if (activity.categoryId === null) return true;
    return !hiddenCategories.has(activity.categoryId);
  });
}

// ============================================================
// 分母（1 章）
// ============================================================

interface ReportDenominators {
  /** フィルタを無視した全アクティビティの記録合計。余白の計算に使う。 */
  totalAllMinutes: number;
  /** 余白（未記録時間）。**フィルタで変わらない**。見出しに数字として出すだけで、配分には混ぜない。 */
  marginMinutes: number;
  /** 見えているインク（仕様の `V`）。 */
  visibleMinutes: number;
  /** 配分の分母（仕様の `track`）。見えている記録の合計そのもの。0 除算を避けるため最小 1。 */
  trackMinutes: number;
}

/**
 * 時間の使い方の分母を出す（仕様 §1）。
 *
 * **配分の分母は記録時間の合計**（2026-09-15 User 裁可）。「仕事を優先したから納得」という
 * 読み方は記録の中での比率でないと成り立たない。余白（書かれていない時間）は配分に混ぜず、
 * 見出しの数字にだけ出す。以前の「週 = 168h を分母にした決算バー」はこの裁可で廃止した。
 *
 * `marginMinutes` はフィルタに依存しない。カテゴリを 1 つ隠しても余白の値は動かず、
 * 動くのは `visibleMinutes` と `trackMinutes` だけ（仕様 §10 の 13-2）。
 */
export function computeDenominators(options: {
  allActivities: readonly ReportActivityAggregate[];
  visibleActivities: readonly ReportActivityAggregate[];
  lengthMinutes: number;
}): ReportDenominators {
  const totalAllMinutes = sumRecorded(options.allActivities);
  const marginMinutes = options.lengthMinutes - totalAllMinutes;
  const visibleMinutes = sumRecorded(options.visibleActivities);

  return {
    totalAllMinutes,
    marginMinutes,
    visibleMinutes,
    trackMinutes: Math.max(1, visibleMinutes),
  };
}

/** 見えている記録の件数。細かく分ければ増える数なので、多いほど良い指標にはしない。 */
export function countRecordBoxes(visibleActivities: readonly ReportActivityAggregate[]): number {
  return visibleActivities.reduce((total, activity) => total + activity.recordBoxes, 0);
}

function sumRecorded(activities: readonly ReportActivityAggregate[]): number {
  return activities.reduce((total, activity) => total + activity.recordedMinutes, 0);
}

/** `track` に対する百分率。表示直前に整数へ丸める。 */
export function toPercent(minutes: number, trackMinutes: number): number {
  return Math.round((minutes / Math.max(1, trackMinutes)) * 100);
}

// ============================================================
// 1 章: 決算バーと凡例
// ============================================================

export interface ReportAllocationSlice {
  /** カテゴリー ID。未分類は `UNCATEGORIZED_KEY`。 */
  key: string;
  label: string | null;
  color: string | null;
  icon: string | null;
  minutes: number;
  percent: number;
}

/**
 * 配分の内訳の単位（仕様 §1 の表）。見えている集合から導く。
 *
 * - 見えているカテゴリー（未分類を含む）が 2 つ以上 → カテゴリー別
 * - カテゴリーが 1 つでアクティビティが 2 つ以上 → その配下のアクティビティ別
 * - アクティビティが 1 つだけ → 配分を出さない（自分自身の 100% は情報にならない）
 *
 * サイドバーの選択ではなく記録のある集合で決める。1 つのカテゴリーだけを残しても、
 * その期間に記録が無ければ出すものが無い。
 */
export function resolveAllocationMode(
  visibleActivities: readonly ReportActivityAggregate[],
): 'category' | 'activity' | 'none' {
  const withInk = visibleActivities.filter((activity) => activity.recordedMinutes > 0);
  const categoryKeys = new Set(withInk.map((activity) => activity.categoryId ?? UNCATEGORIZED_KEY));
  if (categoryKeys.size >= 2) return 'category';
  const activityKeys = new Set(withInk.map((activity) => activity.activityId ?? UNCATEGORIZED_KEY));
  return activityKeys.size >= 2 ? 'activity' : 'none';
}

/**
 * 配分の横棒の区画（仕様 §1）。`mode` に応じてカテゴリー別 / アクティビティ別に割る。
 *
 * **余白の区画は作らない** — 余白は配分に混ぜない（`trackMinutes` は記録の合計）。
 * 記録が 0 の行は持たない。
 */
export function buildAllocationSlices(
  visibleActivities: readonly ReportActivityAggregate[],
  trackMinutes: number,
  mode: 'category' | 'activity',
): ReportAllocationSlice[] {
  const slices = new Map<string, ReportAllocationSlice>();

  for (const activity of visibleActivities) {
    if (activity.recordedMinutes <= 0) continue;

    const key =
      mode === 'activity'
        ? (activity.activityId ?? UNCATEGORIZED_KEY)
        : (activity.categoryId ?? UNCATEGORIZED_KEY);
    const existing = slices.get(key);

    if (existing) {
      existing.minutes += activity.recordedMinutes;
      continue;
    }

    slices.set(key, {
      key,
      label: mode === 'activity' ? activity.activityName : activity.categoryName,
      color: activity.categoryColor,
      icon: activity.categoryIcon,
      minutes: activity.recordedMinutes,
      percent: 0,
    });
  }

  return [...slices.values()]
    .map((slice) => ({ ...slice, percent: toPercent(slice.minutes, trackMinutes) }))
    .sort((a, b) => b.minutes - a.minutes);
}

// ============================================================
// 時間の使い方: 数字のカード（記録時間 / 件数 / 1 件の中央値）
// ============================================================

/** 期間の前と比べるための 1 組の数字。 */
export interface ReportUsageFigures {
  recordedMinutes: number;
  recordCount: number;
  /** 1 件あたりの長さの中央値（分）。数えられる記録が無ければ `null`。 */
  medianMinutes: number | null;
}

export interface ReportUsageSummary {
  current: ReportUsageFigures;
  /**
   * 前期間の同じ集合（今見えているアクティビティ）の数字。前期間にインクが 1 分も無ければ
   * `null`（比較する相手がいないので差を作らない）。
   */
  previous: ReportUsageFigures | null;
}

type PreviousAggregate = {
  activityId: string | null;
  recordedMinutes: number;
  recordBoxes: number;
  durationCounts: readonly (readonly [number, number])[];
};

/**
 * 数字のカードの値（仕様 §1 ①）。
 *
 * 前期間は「今見えているアクティビティ」に絞って足す。フィルタを掛けたまま期間を比べる
 * （現在はフィルタ後、前期間はフィルタ前、と分母が食い違う比較をしない）。
 */
export function buildUsageSummary(
  visibleActivities: readonly ReportActivityAggregate[],
  previousActivities: readonly PreviousAggregate[],
): ReportUsageSummary {
  const current: ReportUsageFigures = {
    recordedMinutes: sumRecorded(visibleActivities),
    recordCount: countRecordBoxes(visibleActivities),
    medianMinutes: medianFromDurationCounts(
      mergeDurationCounts(visibleActivities.map((activity) => activity.durationCounts)),
    ),
  };

  const previousTotal = previousActivities.reduce((total, row) => total + row.recordedMinutes, 0);
  if (previousTotal < 1) return { current, previous: null };

  const visibleIds = new Set(visibleActivities.map((activity) => activity.activityId));
  const previousVisible = previousActivities.filter((row) => visibleIds.has(row.activityId));
  return {
    current,
    previous: {
      recordedMinutes: previousVisible.reduce((total, row) => total + row.recordedMinutes, 0),
      recordCount: previousVisible.reduce((total, row) => total + row.recordBoxes, 0),
      medianMinutes: medianFromDurationCounts(
        mergeDurationCounts(previousVisible.map((row) => row.durationCounts)),
      ),
    },
  };
}

/** `[長さ, 件数]` の度数を複数まとめて、長さの昇順に畳み直す。 */
export function mergeDurationCounts(
  lists: readonly (readonly (readonly [number, number])[])[],
): [number, number][] {
  const counts = new Map<number, number>();
  for (const list of lists) {
    for (const [minutes, count] of list) counts.set(minutes, (counts.get(minutes) ?? 0) + count);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * 度数からの中央値。偶数件は中央 2 件の平均（`medianOf` と同じ規則）。0 件は `null`。
 */
export function medianFromDurationCounts(
  counts: readonly (readonly [number, number])[],
): number | null {
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;

  // 0 始まりの順位 `index` にある値
  const valueAt = (index: number): number => {
    let seen = 0;
    for (const [minutes, count] of counts) {
      seen += count;
      if (index < seen) return minutes;
    }
    return counts[counts.length - 1]?.[0] ?? 0;
  };

  const middle = Math.floor(total / 2);
  return total % 2 === 1 ? valueAt(middle) : (valueAt(middle - 1) + valueAt(middle)) / 2;
}

// ============================================================
// 時間の使い方: 時間帯の分布 / 1 件の長さの分布
// ============================================================

/** 見えているアクティビティの 0〜23 時の記録（分）を足す。 */
export function buildHourTotals(visibleActivities: readonly ReportActivityAggregate[]): number[] {
  const totals = Array.from({ length: 24 }, () => 0);
  for (const activity of visibleActivities) {
    activity.byHour.forEach((minutes, index) => {
      totals[index] = (totals[index] ?? 0) + minutes;
    });
  }
  return totals;
}

/**
 * 1 件の長さの分布の区切り（分、下限を含み上限を含まない）。最後は上限なし。
 *
 * 短い記録ほど細かく刻む。「20 分前後に集まっている」のか「1〜2 時間が多い」のかを
 * 読み分けるための幅で、等間隔にはしない。
 */
const REPORT_DURATION_BIN_EDGES = [0, 5, 10, 15, 30, 45, 60, 90, 120] as const;

export interface ReportDurationBin {
  /** 下限（分、含む）。 */
  fromMinutes: number;
  /** 上限（分、含まない）。最後のビンは `null`（上限なし）。 */
  toMinutes: number | null;
  count: number;
}

/** 度数を `REPORT_DURATION_BIN_EDGES` のビンへ振り分ける。 */
export function buildDurationBins(
  counts: readonly (readonly [number, number])[],
): ReportDurationBin[] {
  const bins: ReportDurationBin[] = REPORT_DURATION_BIN_EDGES.map((from, index) => ({
    fromMinutes: from,
    toMinutes: REPORT_DURATION_BIN_EDGES[index + 1] ?? null,
    count: 0,
  }));
  for (const [minutes, count] of counts) {
    let target = bins[0];
    for (const bin of bins) if (minutes >= bin.fromMinutes) target = bin;
    if (target) target.count += count;
  }
  return bins;
}

// ============================================================
// 時間の使い方: アクティビティ一覧
// ============================================================

export type ReportUsageSortKey = 'recorded' | 'delta';

export interface ReportActivityUsageRow {
  activityId: string | null;
  name: string | null;
  categoryName: string | null;
  color: string | null;
  archived: boolean;
  recordedMinutes: number;
  recordBoxes: number;
  /** 1 件あたりの長さの中央値（分）。数えられる記録が無ければ `null`。 */
  medianRecordMinutes: number | null;
  /** 前期間との差（分）。前期間にインクが 1 分も無ければ `null`（比較する相手がいない）。 */
  deltaMinutes: number | null;
}

/**
 * 時間の使い方の一覧（仕様 §1 ④）。記録のある行をすべて出す（足切りしない）。
 *
 * 差は行ごとに `rec − 前期間の rec`。前期間にインクが 1 分も無ければ全行 `null` にする
 * （見出しの Δ と同じ規則。0 と「比較できない」を混ぜない）。
 */
export function buildActivityUsageRows(
  visibleActivities: readonly ReportActivityAggregate[],
  previousActivities: readonly Pick<PreviousAggregate, 'activityId' | 'recordedMinutes'>[],
): ReportActivityUsageRow[] {
  const previousTotal = previousActivities.reduce((total, row) => total + row.recordedMinutes, 0);
  const previousByActivity = new Map(
    previousActivities.map((row) => [row.activityId, row.recordedMinutes]),
  );

  return visibleActivities
    .filter((activity) => activity.recordedMinutes > 0)
    .map((activity) => ({
      activityId: activity.activityId,
      name: activity.activityName,
      categoryName: activity.categoryName,
      color: activity.categoryColor,
      archived: activity.archived,
      recordedMinutes: activity.recordedMinutes,
      recordBoxes: activity.recordBoxes,
      medianRecordMinutes: medianFromDurationCounts(activity.durationCounts),
      deltaMinutes:
        previousTotal < 1
          ? null
          : activity.recordedMinutes - (previousByActivity.get(activity.activityId) ?? 0),
    }));
}

/**
 * 一覧の並び。記録時間の多い順が既定（規模で読む）。差の順は「最近増えたもの」を探す並び。
 * 差が `null` の行は末尾。同点は記録時間、さらに名前で安定させる。
 */
export function sortActivityUsageRows(
  rows: readonly ReportActivityUsageRow[],
  sortKey: ReportUsageSortKey,
): ReportActivityUsageRow[] {
  const byName = (a: ReportActivityUsageRow, b: ReportActivityUsageRow) =>
    (a.name ?? '').localeCompare(b.name ?? '');
  return [...rows].sort((a, b) => {
    if (sortKey === 'delta') {
      if (a.deltaMinutes === null && b.deltaMinutes !== null) return 1;
      if (a.deltaMinutes !== null && b.deltaMinutes === null) return -1;
      const byDelta = (b.deltaMinutes ?? 0) - (a.deltaMinutes ?? 0);
      if (byDelta !== 0) return byDelta;
    }
    return b.recordedMinutes - a.recordedMinutes || byName(a, b);
  });
}

// ============================================================
// 1 章: 日別のインク
// ============================================================

export interface ReportInkColumn {
  key: string;
  /** カテゴリー別の積み上げ。記録 0 のカテゴリは含まない。 */
  stacks: { key: string; label: string | null; color: string | null; minutes: number }[];
  totalMinutes: number;
}

/**
 * 日別（週）／週別（月）／月別（年）のインク（仕様 §4.1）。
 *
 * 高さは呼び出し側が `maxColumnMinutes` で比例配分する。ここでは数値だけを返す。
 */
export function buildInkColumns(
  visibleActivities: readonly ReportActivityAggregate[],
  bucketKeys: readonly string[],
): ReportInkColumn[] {
  return bucketKeys.map((key, index) => {
    const stacks = new Map<string, ReportInkColumn['stacks'][number]>();

    for (const activity of visibleActivities) {
      const minutes = activity.byBucket[index] ?? 0;
      if (minutes <= 0) continue;

      const stackKey = activity.categoryId ?? UNCATEGORIZED_KEY;
      const existing = stacks.get(stackKey);
      if (existing) {
        existing.minutes += minutes;
        continue;
      }
      stacks.set(stackKey, {
        key: stackKey,
        label: activity.categoryName,
        color: activity.categoryColor,
        minutes,
      });
    }

    const list = [...stacks.values()].sort((a, b) => b.minutes - a.minutes);
    return {
      key,
      stacks: list,
      totalMinutes: list.reduce((total, stack) => total + stack.minutes, 0),
    };
  });
}

/** 日別インクの縦軸スケール。全列が 0 でも 1 を返す（0 除算防止）。 */
export function maxInkColumnMinutes(columns: readonly ReportInkColumn[]): number {
  return Math.max(1, ...columns.map((column) => column.totalMinutes));
}

// ============================================================
// 2 章: 執行
// ============================================================

export interface ReportExecutionRow {
  activityId: string | null;
  name: string | null;
  categoryName: string | null;
  color: string | null;
  archived: boolean;
  recordedMinutes: number;
  plannedMinutes: number;
  plannedPastMinutes: number;
  /** 記録バーの幅（0〜1）。 */
  recordedRatio: number;
  /** 予定バー（破線）の幅（0〜1）。予定が無ければ `null` で、バーを描かない。 */
  plannedRatio: number | null;
  /**
   * 予定比（%）。`plannedPastMinutes` が閾値未満なら `null`。
   * 数えるに足りない回数で比率を作らない（仕様 §0-4）。
   */
  planRatioPercent: number | null;
}

/**
 * 2 章の行（仕様 §4.2）。
 *
 * 記録か予定のどちらかがある行をすべて出す。**足切りしない**（決算の完全性）。
 */
export function buildExecutionRows(
  visibleActivities: readonly ReportActivityAggregate[],
): ReportExecutionRow[] {
  const rows = visibleActivities.filter(
    (activity) => activity.recordedMinutes > 0 || activity.plannedMinutes > 0,
  );

  const scale = Math.max(
    1,
    ...rows.map((row) => Math.max(row.recordedMinutes, row.plannedMinutes)),
  );

  return rows
    .map((activity) => ({
      activityId: activity.activityId,
      name: activity.activityName,
      categoryName: activity.categoryName,
      color: activity.categoryColor,
      archived: activity.archived,
      recordedMinutes: activity.recordedMinutes,
      plannedMinutes: activity.plannedMinutes,
      plannedPastMinutes: activity.plannedPastMinutes,
      recordedRatio: activity.recordedMinutes / scale,
      plannedRatio: activity.plannedMinutes > 0 ? activity.plannedMinutes / scale : null,
      planRatioPercent:
        activity.plannedPastMinutes >= EXECUTION_MIN_PLAN_MINUTES
          ? Math.round((activity.recordedMinutes / activity.plannedPastMinutes) * 100)
          : null,
    }))
    .sort((a, b) => b.recordedMinutes - a.recordedMinutes);
}

// ============================================================
// 2 章: 見積もりの鏡
// ============================================================

export type ReportMirrorTone = 'over' | 'under' | 'onPlan';

export interface ReportMirrorRow {
  activityId: string | null;
  name: string | null;
  categoryName: string | null;
  color: string | null;
  /** `rec / planPast`。1 より大きいほど予定より伸びている。 */
  coefficient: number;
  tone: ReportMirrorTone;
}

/** 「予定より伸びる」と読む係数の下限。 */
const MIRROR_OVER_THRESHOLD = 1.12;
/** 「切り上げがち」と読む係数の上限。 */
const MIRROR_UNDER_THRESHOLD = 0.88;

/**
 * 見積もりの鏡（仕様 §4.2）。
 *
 * 候補は「過去予定が 30 分以上」「記録がある」「過去予定の箱が 3 つ以上」の 3 条件をすべて
 * 満たす行だけ。`|coef − 1|` の降順（癖の強い順）で最大 3 件。
 * **全体遵守率のような合成値は作らない。**
 */
export function buildMirrorRows(
  visibleActivities: readonly ReportActivityAggregate[],
): ReportMirrorRow[] {
  return visibleActivities
    .filter(
      (activity) =>
        activity.plannedPastMinutes >= MIRROR_MIN_PLAN_MINUTES &&
        activity.recordedMinutes > 0 &&
        activity.plannedPastBoxes >= MIRROR_MIN_PLAN_BOXES,
    )
    .map((activity) => {
      const coefficient = activity.recordedMinutes / activity.plannedPastMinutes;
      return {
        activityId: activity.activityId,
        name: activity.activityName,
        categoryName: activity.categoryName,
        color: activity.categoryColor,
        coefficient,
        tone: resolveMirrorTone(coefficient),
      };
    })
    .sort((a, b) => Math.abs(b.coefficient - 1) - Math.abs(a.coefficient - 1))
    .slice(0, MIRROR_MAX_ROWS);
}

function resolveMirrorTone(coefficient: number): ReportMirrorTone {
  if (coefficient >= MIRROR_OVER_THRESHOLD) return 'over';
  if (coefficient <= MIRROR_UNDER_THRESHOLD) return 'under';
  return 'onPlan';
}

// ============================================================
// 3 章: 羅針盤
// ============================================================

export interface ReportCompassPoint {
  activityId: string | null;
  name: string | null;
  categoryName: string | null;
  color: string | null;
  /** 盤の左からの位置（%）。投下時間に比例。 */
  x: number;
  /** 盤の下からの位置（%）。充実と消耗の差に比例。 */
  y: number;
  /** 濃度＝回答数。回数が少ない点ほど薄い。 */
  opacity: number;
  /** 充実の回答数。 */
  answerCount: number;
  /** 投下時間（分）。読み上げラベルに使う。 */
  recordedMinutes: number;
}

/**
 * 羅針盤の点（仕様 §4.3）。
 *
 * 充実の回答が 5 件に満たないアクティビティは点にしない（待機リストへ回す）。
 * **平均・回帰線・象限の塗り分け・ランキングは作らない。**
 */
export function buildCompassPoints(
  visibleActivities: readonly ReportActivityAggregate[],
): ReportCompassPoint[] {
  const eligible = visibleActivities.filter(
    (activity) =>
      activity.recordedMinutes > 0 && answerCountOf(activity) >= COMPASS_MIN_FULFILLMENT,
  );

  const maxRecorded = Math.max(1, ...eligible.map((activity) => activity.recordedMinutes));

  return eligible.map((activity) => {
    const answerCount = answerCountOf(activity);
    const slope = (activity.fulfillment.high - activity.fulfillment.low) / answerCount;
    return {
      activityId: activity.activityId,
      name: activity.activityName,
      categoryName: activity.categoryName,
      color: activity.categoryColor,
      x: 6 + (activity.recordedMinutes / maxRecorded) * 86,
      y: 14 + ((slope + 1) / 2) * 72,
      opacity: 0.35 + Math.min(answerCount, 5) * 0.13,
      answerCount,
      recordedMinutes: activity.recordedMinutes,
    };
  });
}

export interface ReportWaitingActivity {
  activityId: string | null;
  name: string | null;
}

/**
 * 点になるのを待っているアクティビティ（仕様 §4.3）。
 *
 * 記録はあるが充実の回答がまだ足りない行。名前だけを並べる。
 */
export function buildCompassWaitingList(
  visibleActivities: readonly ReportActivityAggregate[],
): ReportWaitingActivity[] {
  return visibleActivities
    .filter(
      (activity) =>
        activity.recordedMinutes > 0 && answerCountOf(activity) < COMPASS_MIN_FULFILLMENT,
    )
    .sort((a, b) => b.recordedMinutes - a.recordedMinutes)
    .map((activity) => ({ activityId: activity.activityId, name: activity.activityName }));
}

/** 充実の回答数（仕様の `n`）。未回答の記録は数えない。 */
export function answerCountOf(activity: ReportActivityAggregate): number {
  const { low, medium, high } = activity.fulfillment;
  return low + medium + high;
}
