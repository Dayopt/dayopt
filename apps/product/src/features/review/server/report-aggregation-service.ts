import 'server-only';

import { toDerivedBlock } from '@/lib/database';
import { aggregate } from '@/lib/time';

import { isMedianEligibleSource } from '../domain/report/duration-distribution';
import {
  clipMinutes,
  distributeToHours,
  REPORT_HOUR_BUCKETS,
  resolvePreviousReportRange,
  resolveReportRange,
  type ReportGranularity,
  type ReportWeekStartsOn,
} from '../lib/report-period';

import {
  fetchReportActivities,
  fetchReportCategories,
  fetchReportPlans,
  fetchReportRecords,
  type ReportActivityRow,
  type ReportCategoryRow,
  type ReportFetchClient,
  type ReportPlanRow,
  type ReportRecordRow,
} from './report-fetchers';

/**
 * `/report` の各タブが読む期間集計。
 *
 * **返すのはアクティビティ別のスカラーだけ。** フィルタ（カテゴリー / アクティビティ /
 * 未分類 / 余白）・分母・見積もりの鏡・羅針盤の座標は、すべて client の純粋関数
 * （`domain/report/`）が導出する。トグルのたびにサーバーへ往復させないため。
 *
 * **箱の明細は載せない。** 各タブに要る箱の情報は件数（`plannedPastBoxes` / `recordBoxes`）・
 * 充実の回答数・長さの度数（`durationCounts`）・時間帯（`byHour`）だけで、どれも件数に比例しない。
 * 明細・分布・時間帯が要るのは詳細パネルだけなので、開いた時に専用 procedure で取る。
 * 年粒度で payload が Record 件数に線形比例するのを構造的に断つ。
 */

/** 充実の 3 値（`records.fulfillment`）。UI では 消耗 / 普通 / 充実。 */
export interface ReportFulfillmentCounts {
  low: number;
  medium: number;
  high: number;
}

export interface ReportActivityAggregate {
  /** `null` はアクティビティ未設定の記録・予定。表示側は未分類として扱う。 */
  activityId: string | null;
  activityName: string | null;
  /** `null` は未分類（`activities.category_id IS NULL`、またはアクティビティ未設定）。 */
  categoryId: string | null;
  categoryName: string | null;
  /** カテゴリーの色名（10 色）。表示側が semantic token へ写す。 */
  categoryColor: string | null;
  categoryIcon: string | null;
  /** アーカイブ済みでも期間内にインクがあれば行を返す。表示側の注記に使う。 */
  archived: boolean;
  /** 仕様の `rec`。期間へ clip 済み。 */
  recordedMinutes: number;
  /** 仕様の `plan`。期間へ clip 済み。 */
  plannedMinutes: number;
  /** 仕様の `planPast`。開始が `nowAt` 以下の予定だけ。未来の予定で係数を汚さない。 */
  plannedPastMinutes: number;
  /** 仕様の `planBoxesPast`。見積もりの鏡の候補条件に使う。 */
  plannedPastBoxes: number;
  recordBoxes: number;
  /**
   * 1 件あたりの長さ（分、整数へ丸め）ごとの件数。`[長さ, 件数]` を長さの昇順で持つ。
   *
   * 母集団は詳細パネルの中央値と同じ（clip 済み・`auto_migrated` を除く）。**明細ではなく
   * 長さの度数**なので、件数ではなく「異なる長さの数」に比例する（1 日 = 最大 1440 通り）。
   * 見えているアクティビティを client で合算すれば、どのフィルタでも全体の中央値と分布が
   * 正確に出る（中央値の中央値は中央値にならないため、スカラーの中央値だけでは足りない）。
   */
  durationCounts: [number, number][];
  /** `REPORT_HOUR_BUCKETS` と同 index（0〜23 時）。期間へ clip し、0 時またぎは按分済み。 */
  byHour: number[];
  fulfillment: ReportFulfillmentCounts;
  /** `period.bucketKeys` と同 index。記録ぶん。0 時またぎは按分済み。 */
  byBucket: number[];
}

/** 前期間の比較に使う最小限の集計。 */
interface ReportPreviousActivityAggregate {
  activityId: string | null;
  recordedMinutes: number;
  recordBoxes: number;
  /** `ReportActivityAggregate.durationCounts` と同じ形・同じ母集団。 */
  durationCounts: [number, number][];
}

interface ReportPeriodSummary {
  startAt: string;
  endAt: string;
  /** 余白の分母（仕様の `L`）。DST を無視した公称値。 */
  lengthMinutes: number;
  bucketKeys: string[];
}

interface ReportPeriodResult {
  period: ReportPeriodSummary;
  previous: Omit<ReportPeriodSummary, 'bucketKeys'>;
  /** `plannedPastMinutes` の判定基準。client の時計とずれてもサーバーの値で一貫させる。 */
  nowAt: string;
  activities: ReportActivityAggregate[];
  /** 前期間の比較用（記録時間・件数・1 件の長さ）。 */
  previousActivities: ReportPreviousActivityAggregate[];
}

interface ReportPeriodInput {
  anchorDate: string;
  granularity: ReportGranularity;
  timezone: string;
  weekStartsOn: ReportWeekStartsOn;
}

/** 集計の途中状態。`ReportActivityAggregate` から表示用のメタを除いたもの。 */
interface ActivityBucketState {
  recordedMinutes: number;
  plannedMinutes: number;
  plannedPastMinutes: number;
  plannedPastBoxes: number;
  recordBoxes: number;
  durationCounts: [number, number][];
  byHour: number[];
  fulfillment: ReportFulfillmentCounts;
  byBucket: number[];
}

/**
 * 公開するのは `createReportAggregationService` だけ。呼び出し側（router / test）は
 * factory 経由で受け取り、戻り値の型は推論で拾う。
 */
class ReportAggregationService {
  constructor(private readonly supabase: ReportFetchClient) {}

  async getReportPeriod(
    userId: string,
    input: ReportPeriodInput,
    now: Date = new Date(),
  ): Promise<ReportPeriodResult> {
    const { anchorDate, granularity, timezone, weekStartsOn } = input;
    const range = resolveReportRange(anchorDate, granularity, timezone, weekStartsOn);
    const previousRange = resolvePreviousReportRange(
      anchorDate,
      granularity,
      timezone,
      weekStartsOn,
    );
    const nowAt = now.toISOString();

    const [records, plans, previousRecords, activities, categories] = await Promise.all([
      fetchReportRecords(this.supabase, userId, range),
      fetchReportPlans(this.supabase, userId, range),
      fetchReportRecords(this.supabase, userId, previousRange),
      fetchReportActivities(this.supabase, userId),
      fetchReportCategories(this.supabase, userId),
    ]);

    const activityById = new Map(activities.map((row) => [row.id, row]));
    const categoryById = new Map(categories.map((row) => [row.id, row]));

    const states = this.buildStates(records, plans, range, now, timezone);

    return {
      period: {
        startAt: range.startAt,
        endAt: range.endAt,
        lengthMinutes: range.lengthMinutes,
        bucketKeys: range.buckets.map((bucket) => bucket.key),
      },
      previous: {
        startAt: previousRange.startAt,
        endAt: previousRange.endAt,
        lengthMinutes: previousRange.lengthMinutes,
      },
      nowAt,
      activities: [...states].map(([activityId, state]) =>
        this.toAggregate(activityId, state, activityById, categoryById),
      ),
      previousActivities: this.buildPreviousTotals(previousRecords, previousRange, timezone, now),
    };
  }

  private buildStates(
    records: ReportRecordRow[],
    plans: ReportPlanRow[],
    range: ReturnType<typeof resolveReportRange>,
    now: Date,
    timezone: string,
  ): Map<string | null, ActivityBucketState> {
    const blocks = [
      ...plans.map((row) => toDerivedBlock(row, 'plan')),
      ...records.map((row) => toDerivedBlock(row, 'rec')),
    ];
    const eligibleMinutes = this.collectMedianEligibleMinutes(records, range);
    const hoursByActivity = this.collectHourTotals(records, range, timezone);
    const states = new Map<string | null, ActivityBucketState>();
    for (const activityId of new Set(blocks.map((block) => block.activityId))) {
      const totals = aggregate({ ...range, timezone }, activityId, blocks, now);
      states.set(activityId, {
        recordedMinutes: totals.recordedMinutes,
        plannedMinutes: totals.plannedMinutes,
        plannedPastMinutes: totals.plannedPastMinutes,
        plannedPastBoxes: totals.plannedPastBoxes,
        recordBoxes: totals.recordBoxes,
        durationCounts: toDurationCounts(eligibleMinutes.get(activityId) ?? []),
        byHour: hoursByActivity.get(activityId) ?? REPORT_HOUR_BUCKETS.map(() => 0),
        fulfillment: totals.fulfillment,
        byBucket: range.buckets.map(
          (bucket) => aggregate({ ...bucket, timezone }, activityId, blocks, now).recordedMinutes,
        ),
      });
    }
    return states;
  }

  private toAggregate(
    activityId: string | null,
    state: ActivityBucketState,
    activityById: Map<string, ReportActivityRow>,
    categoryById: Map<string, ReportCategoryRow>,
  ): ReportActivityAggregate {
    const activity = activityId === null ? undefined : activityById.get(activityId);
    const category =
      activity?.category_id == null ? undefined : categoryById.get(activity.category_id);

    return {
      activityId,
      activityName: activity?.name ?? null,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      categoryColor: category?.color ?? null,
      categoryIcon: category?.icon ?? null,
      archived: activity?.archived_at != null,
      recordedMinutes: state.recordedMinutes,
      plannedMinutes: state.plannedMinutes,
      plannedPastMinutes: state.plannedPastMinutes,
      plannedPastBoxes: state.plannedPastBoxes,
      recordBoxes: state.recordBoxes,
      durationCounts: state.durationCounts,
      byHour: state.byHour,
      fulfillment: state.fulfillment,
      byBucket: state.byBucket,
    };
  }

  /**
   * 1 件あたりの中央値の母集団を、アクティビティごとに集める。
   *
   * 詳細パネル（`report-detail-service.ts`）と同じ規則: `clipMinutes` で期間へ切った長さ、
   * `auto_migrated` は除く、clip して 0 になる行は数えない。規則をここで変えると、
   * 一覧の中央値と詳細パネルの中央値が同じアクティビティで食い違う。
   */
  private collectMedianEligibleMinutes(
    records: ReportRecordRow[],
    range: { startAt: string; endAt: string },
  ): Map<string | null, number[]> {
    const byActivity = new Map<string | null, number[]>();
    for (const record of records) {
      if (!isMedianEligibleSource(record.source)) continue;
      const minutes = clipMinutes(record.start_at, record.end_at, range.startAt, range.endAt);
      if (minutes <= 0) continue;
      const list = byActivity.get(record.activity_id) ?? [];
      list.push(minutes);
      byActivity.set(record.activity_id, list);
    }
    return byActivity;
  }

  private buildPreviousTotals(
    records: ReportRecordRow[],
    range: { startAt: string; endAt: string },
    timezone: string,
    now: Date,
  ): ReportPreviousActivityAggregate[] {
    const blocks = records.map((row) => toDerivedBlock(row, 'rec'));
    const eligibleMinutes = this.collectMedianEligibleMinutes(records, range);
    return [...new Set(blocks.map((block) => block.activityId))].map((activityId) => {
      const totals = aggregate({ ...range, timezone }, activityId, blocks, now);
      return {
        activityId,
        recordedMinutes: totals.recordedMinutes,
        recordBoxes: totals.recordBoxes,
        durationCounts: toDurationCounts(eligibleMinutes.get(activityId) ?? []),
      };
    });
  }

  /**
   * 記録を 0〜23 時へ按分し、アクティビティごとに足す（分）。記録を 1 周するだけで済ませる。
   *
   * 期間へ clip してから按分するので、期間の外にはみ出した部分は数えない（日別の棒と合計が揃う）。
   */
  private collectHourTotals(
    records: ReportRecordRow[],
    range: { startAt: string; endAt: string },
    timezone: string,
  ): Map<string | null, number[]> {
    const byActivity = new Map<string | null, number[]>();
    const rangeStartMs = Date.parse(range.startAt);
    const rangeEndMs = Date.parse(range.endAt);
    for (const record of records) {
      const startMs = Math.max(Date.parse(record.start_at), rangeStartMs);
      const endMs = Math.min(Date.parse(record.end_at), rangeEndMs);
      if (!(endMs > startMs)) continue;
      const totals = byActivity.get(record.activity_id) ?? REPORT_HOUR_BUCKETS.map(() => 0);
      distributeToHours(
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        timezone,
      ).forEach((minutes, index) => {
        totals[index] = (totals[index] ?? 0) + minutes;
      });
      byActivity.set(record.activity_id, totals);
    }
    return byActivity;
  }
}

/** 長さの配列を `[長さ（分、整数）, 件数]` の昇順へ畳む。 */
function toDurationCounts(minutes: readonly number[]): [number, number][] {
  const counts = new Map<number, number>();
  for (const value of minutes) {
    const rounded = Math.max(1, Math.round(value));
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

export function createReportAggregationService(supabase: ReportFetchClient) {
  return new ReportAggregationService(supabase);
}
