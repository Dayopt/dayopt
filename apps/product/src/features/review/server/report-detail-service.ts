import 'server-only';

import { toDerivedBlock } from '@/lib/database';
import { aggregate } from '@/lib/time';

import { isMedianEligibleSource, medianOf } from '../domain/report/duration-distribution';
import {
  clipMinutes,
  distributeToTimeOfDay,
  REPORT_TIME_OF_DAY_BUCKETS,
  resolveReportRange,
  shiftReportAnchor,
  type ReportGranularity,
  type ReportWeekStartsOn,
} from '../lib/report-period';

import {
  fetchReportDetailPlans,
  fetchReportDetailRecords,
  REPORT_DETAIL_RECORD_LIMIT,
  type ReportDetailRecordRow,
  type ReportFetchClient,
} from './report-fetchers';

/**
 * 詳細パネル（仕様 §6）が読む 1 アクティビティ分の明細。
 *
 * **期間集計（`getReportPeriod`）とは別 procedure。** 1〜4 章に要るのはスカラーだけで、
 * 箱の明細・中央値・時間帯分布はパネルを開いた時にしか要らない。同じ payload に載せると
 * 年粒度で Record 件数に線形比例して膨らむ（#2576 の設計）。
 *
 * **平均を出さない**（仕様 §0-4）。1 箱の代表値は中央値だけを返し、component 側で平均を
 * 計算する余地も作らない。
 *
 * **中央値だけ `auto_migrated` を除く。** 自動移行の Record はユーザーが確定した実績では
 * ないので、代表値には数えない（作成パネルの「普段の長さ」と同じ規則）。合計・充実・時間帯・
 * 明細は「実際にその時間が埋まっていた」事実なので全件を数える。
 */

/** 充実の 3 値。未回答の記録は数えない。 */
export interface ReportDetailFulfillment {
  low: number;
  medium: number;
  high: number;
}

export interface ReportDetailRecord {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  /** 期間へ clip 済みの長さ（分）。 */
  minutes: number;
  fulfillment: keyof ReportDetailFulfillment | null;
  note: string | null;
  /** `'auto_migrated'` はストリップの点にしない（中央値と同じ規則で表示側が絞る）。 */
  source: string;
}

export interface ReportDetailTrendPoint {
  /** 期間の初日（`YYYY-MM-DD`）。表示側はラベルを持たず、並び順だけを使う。 */
  key: string;
  recordedMinutes: number;
  /** その期間の 1 件あたりの中央値。記録が無い期間は `null`（0 ではない）。 */
  medianBoxMinutes: number | null;
}

export interface ReportActivityDetailResult {
  recordedMinutes: number;
  plannedMinutes: number;
  plannedPastMinutes: number;
  plannedPastBoxes: number;
  /** 期間内の記録ボックス長の中央値。0 件は `null`（**平均ではない**）。 */
  medianBoxMinutes: number | null;
  /**
   * 期間内で**開始済み**の予定 1 件あたりの長さの中央値。0 件は `null`。
   *
   * 記録の中央値と並べて「1 回あたりどれだけ見誤っているか」を出すために持つ。合計比
   * （見積もりの鏡）は総量のずれしか言えず、回数が違うと同じ係数でも意味が変わる。
   */
  medianPlanBoxMinutes: number | null;
  fulfillment: ReportDetailFulfillment;
  /** `REPORT_TIME_OF_DAY_BUCKETS` と同 index。分単位・重なり分は按分済み。 */
  timeOfDay: number[];
  /** 直近 6 期間（末尾が表示中の期間）。`includeTrend: false` なら空配列。 */
  trend: ReportDetailTrendPoint[];
  /** 期間内の記録明細。`start_at` 昇順、上限 200 件。 */
  records: ReportDetailRecord[];
}

interface ReportActivityDetailInput {
  /** `null` はアクティビティ未設定の記録。 */
  activityId: string | null;
  anchorDate: string;
  granularity: ReportGranularity;
  timezone: string;
  weekStartsOn: ReportWeekStartsOn;
  /** モバイルは推移を出さないので `false` で呼ぶ（#2582）。 */
  includeTrend: boolean;
}

/** 推移に出す期間数（表示中の期間を含む）。 */
const TREND_PERIOD_COUNT = 6;

function isFulfillmentLevel(value: string | null): value is keyof ReportDetailFulfillment {
  return value === 'low' || value === 'medium' || value === 'high';
}

class ReportDetailService {
  constructor(private readonly supabase: ReportFetchClient) {}

  async getActivityDetail(
    userId: string,
    input: ReportActivityDetailInput,
    now: Date = new Date(),
  ): Promise<ReportActivityDetailResult> {
    const { activityId, anchorDate, granularity, timezone, weekStartsOn, includeTrend } = input;
    const range = resolveReportRange(anchorDate, granularity, timezone, weekStartsOn);

    // 推移は「表示中を含む直近 6 期間」。6 回 fetch せず、最も古い期間の開始から
    // 現在の期間の終端までを 1 回で取り、期間ごとに clip する。
    // `shiftReportAnchor` は ±1 期間ずつしか動かないので、1 つずつ遡って古い順に並べ直す。
    const trendRanges = includeTrend
      ? this.resolveTrendRanges(anchorDate, granularity, timezone, weekStartsOn)
      : [range];

    const fetchRange = {
      startAt: trendRanges[0]?.startAt ?? range.startAt,
      endAt: range.endAt,
    };

    const [records, plans] = await Promise.all([
      fetchReportDetailRecords(this.supabase, userId, activityId, fetchRange),
      fetchReportDetailPlans(this.supabase, userId, activityId, range),
    ]);

    const periodRecords = records.filter(
      (record) => clipMinutes(record.start_at, record.end_at, range.startAt, range.endAt) > 0,
    );

    const totals = aggregate(
      { ...range, timezone },
      activityId,
      [
        ...plans.map((row) => toDerivedBlock(row, 'plan')),
        ...periodRecords.map((row) => toDerivedBlock(row, 'rec')),
      ],
      now,
    );
    return {
      ...this.summarizeRecords(periodRecords, range, timezone),
      plannedMinutes: totals.plannedMinutes,
      plannedPastMinutes: totals.plannedPastMinutes,
      plannedPastBoxes: totals.plannedPastBoxes,
      recordedMinutes: totals.recordedMinutes,
      // `totals.medianBoxMinutes` は使わない（全件で出るため）。表示側のストリップと同じ
      // 母集団（auto_migrated を除いた clip 済みの長さ）から出す
      medianBoxMinutes: this.resolveRecordMedian(periodRecords, range),
      medianPlanBoxMinutes: this.resolvePlanMedian(plans, range, now),
      fulfillment: totals.fulfillment,
      trend: includeTrend ? this.buildTrend(records, trendRanges, activityId, timezone, now) : [],
      records: this.toDetailRecords(periodRecords, range),
    };
  }

  /**
   * 記録 1 件あたりの長さの中央値（分）。`auto_migrated` は除く。
   *
   * 集計の `aggregate` ではなく `clipMinutes` で出す。明細（`records[]`）の長さと同じ関数を
   * 通すので、カードの中央値とストリップの点が必ず同じ母集団になる。
   */
  private resolveRecordMedian(
    records: ReportDetailRecordRow[],
    range: { startAt: string; endAt: string },
  ): number | null {
    const minutes = records
      .filter((record) => isMedianEligibleSource(record.source))
      .map((record) => clipMinutes(record.start_at, record.end_at, range.startAt, range.endAt))
      .filter((value) => value > 0);

    return medianOf(minutes);
  }

  /**
   * 開始済みの予定 1 件あたりの長さの中央値（分）。0 件は `null`。
   *
   * **まだ始まっていない予定は数えない**（`plannedPastBoxes` と同じ境界）。これから来る予定を
   * 混ぜると、期間の後半に置いた長い予定が「普段の見積もり」を押し上げる。始まって途中の予定は
   * `now` で切る（過去ぶんだけが比較可能な量）。
   */
  private resolvePlanMedian(
    plans: { start_at: string; end_at: string }[],
    range: { startAt: string; endAt: string },
    now: Date,
  ): number | null {
    const nowIso = now.toISOString();
    const minutes = plans
      .filter((plan) => Date.parse(plan.start_at) <= now.getTime())
      .map((plan) =>
        clipMinutes(
          plan.start_at,
          Date.parse(plan.end_at) > now.getTime() ? nowIso : plan.end_at,
          range.startAt,
          range.endAt,
        ),
      )
      .filter((value) => value > 0);

    return medianOf(minutes);
  }

  /** 表示中を含む直近 6 期間を、古い順に返す。 */
  private resolveTrendRanges(
    anchorDate: string,
    granularity: ReportGranularity,
    timezone: string,
    weekStartsOn: ReportWeekStartsOn,
  ) {
    const anchors = [anchorDate];
    for (let index = 1; index < TREND_PERIOD_COUNT; index += 1) {
      const previous = anchors[anchors.length - 1];
      if (previous === undefined) break;
      anchors.push(shiftReportAnchor(previous, granularity, -1));
    }

    return anchors
      .reverse()
      .map((anchor) => resolveReportRange(anchor, granularity, timezone, weekStartsOn));
  }

  private summarizeRecords(
    records: ReportDetailRecordRow[],
    range: { startAt: string; endAt: string },
    timezone: string,
  ): Pick<ReportActivityDetailResult, 'timeOfDay'> {
    const timeOfDay = REPORT_TIME_OF_DAY_BUCKETS.map(() => 0);

    for (const record of records) {
      const minutes = clipMinutes(record.start_at, record.end_at, range.startAt, range.endAt);
      if (minutes <= 0) continue;

      // 時間帯も期間の外へはみ出した分は数えない。clip してから按分する
      const clippedStart =
        Date.parse(record.start_at) < Date.parse(range.startAt) ? range.startAt : record.start_at;
      const clippedEnd =
        Date.parse(record.end_at) > Date.parse(range.endAt) ? range.endAt : record.end_at;

      const distributed = distributeToTimeOfDay(clippedStart, clippedEnd, timezone);
      for (let index = 0; index < distributed.length; index += 1) {
        timeOfDay[index] = (timeOfDay[index] ?? 0) + (distributed[index] ?? 0);
      }
    }

    return {
      timeOfDay,
    };
  }

  private buildTrend(
    records: ReportDetailRecordRow[],
    ranges: { startAt: string; endAt: string; buckets: { key: string }[] }[],
    activityId: string | null,
    timezone: string,
    now: Date,
  ): ReportDetailTrendPoint[] {
    return ranges.map((periodRange) => ({
      key: periodRange.buckets[0]?.key ?? periodRange.startAt,
      recordedMinutes: aggregate(
        { ...periodRange, timezone },
        activityId,
        records.map((row) => toDerivedBlock(row, 'rec')),
        now,
      ).recordedMinutes,
      // 合計は全件、中央値は表示中の期間と同じ規則（auto_migrated を除く）
      medianBoxMinutes: this.resolveRecordMedian(records, periodRange),
    }));
  }

  private toDetailRecords(
    records: ReportDetailRecordRow[],
    range: { startAt: string; endAt: string },
  ): ReportDetailRecord[] {
    return records
      .map((record) => ({
        id: record.id,
        title: record.title,
        startAt: record.start_at,
        endAt: record.end_at,
        minutes: clipMinutes(record.start_at, record.end_at, range.startAt, range.endAt),
        fulfillment: isFulfillmentLevel(record.fulfillment) ? record.fulfillment : null,
        note: record.note,
        source: record.source,
      }))
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .slice(0, REPORT_DETAIL_RECORD_LIMIT);
  }
}

export function createReportDetailService(supabase: ReportFetchClient) {
  return new ReportDetailService(supabase);
}
