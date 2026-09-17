/**
 * レポートの期間契約（週 / 月 / 年）
 *
 * `/report` のすべてのタブが、この 1 箇所が返す `[startAt, endAt)` と `buckets` の上に乗る。
 * client（表示の列見出し・期間移動）と server（集計）の両方から呼ぶため `server-only` は付けない。
 *
 * **半開区間で通す。** `lib/date/timezone.ts` の `tzWeekEnd()` / `toTZEndISO()` は
 * `23:59:59.999` を返す閉区間寄りの表現で、隣接期間の間に 1ms の穴が空く。境界ぴったりに
 * 始まる Record がどちらの期間からも落ちるため、ここでは流用せず `fromZonedTime` で
 * 「次の期間の開始時刻」を終端にする。
 *
 * **DST を意図的に無視する。** `lengthMinutes`（仕様の `L`。余白の分母）は週 = 10080 固定、
 * 月 / 年 = 実日数 × 1440 で計算する。DST のある地域では実際の経過時間と最大 1 時間ずれるが、
 * 「週は 168 時間」という読み手の直感を優先する。ずれは余白（未記録時間）にのみ現れ、
 * 記録・予定の集計値には影響しない。
 */

import { addDays, addMonths, addWeeks, addYears, startOfWeek as dfStartOfWeek } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * レポートの粒度。`day` は持たない（日の解像度はカレンダーの仕事）。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export const reportGranularities = ['week', 'month', 'year'] as const;
/**
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export type ReportGranularity = (typeof reportGranularities)[number];

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export function isReportGranularity(value: unknown): value is ReportGranularity {
  return typeof value === 'string' && (reportGranularities as readonly string[]).includes(value);
}

/** 週の開始曜日（0=日, 1=月, 6=土）。`user_settings.week_starts_on` と同じ 3 値。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export type ReportWeekStartsOn = 0 | 1 | 6;

/**
 * 1 日の分数。DST を無視した公称値。 */
const MINUTES_PER_DAY = 1440;

/** 週の分数。仕様の「週 = 168h」。 */
const MINUTES_PER_WEEK = 10080;

/** 日別・週別・月別の列 1 本。`key` は表示のラベル生成と `byBucket` の対応付けに使う。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export interface ReportBucket {
  /**
   * 週・月粒度なら `YYYY-MM-DD`（列の開始日）、年粒度なら `YYYY-MM`。 */
  key: string;
  /** UTC ISO。半開区間の開始。 */
  startAt: string;
  /** UTC ISO。半開区間の終端（次の列の開始と一致する）。 */
  endAt: string;
}

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportRange {
  /** UTC ISO。期間の開始（含む）。 */
  startAt: string;
  /** UTC ISO。期間の終端（含まない）。次の期間の `startAt` と一致する。 */
  endAt: string;
  /**
   * 余白の分母（仕様の `L`）。週 = 10080 固定、月 / 年 = 実日数 × 1440。
   * DST を無視した公称値で、`endAt - startAt` の実時間とは一致しないことがある。
   */
  lengthMinutes: number;
  /** 日別のインク（1 章）と `byBucket` の列。週 = 7 本、月 = 4〜6 本、年 = 12 本。 */
  buckets: ReportBucket[];
}

/**
 * 壁時計の `YYYY-MM-DD` を、指定 timezone のその日の 00:00 を指す UTC の瞬間へ変換する。
 *
 * `fromZonedTime` に文字列を直接渡すと実行環境のローカル TZ で解釈されうるため、
 * 日付部分だけを組み立てた文字列を渡して timezone を明示する。
 */
function zonedDayStart(dateKey: string, timezone: string): Date {
  return fromZonedTime(`${dateKey}T00:00:00.000`, timezone);
}

/**
 * 指定 timezone での壁時計日付キー（`YYYY-MM-DD`）。
 *
 * `toZonedTime` は使わない（壁時計 Date への誤適用が起きるバグ class、#2017）。
 * instant から日付を読むだけなので `formatInTimeZone` で足りる。
 */
function toZonedDateKey(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, 'yyyy-MM-dd');
}

/**
 * instant（UTC ISO）を、指定 timezone の壁時計日付キー（`YYYY-MM-DD`）へ。
 *
 * カレンダーへのジャンプ先（`/calendar?view=day&date=`）を組むのに使う。UTC のまま日付を切ると、
 * 深夜の記録が前後の日へずれてカレンダーが「何も無い日」を開く。
 */
export function resolveZonedDayKey(instant: string, timezone: string): string {
  return toZonedDateKey(new Date(instant), timezone);
}

/** `YYYY-MM-DD` を、TZ 非依存の壁時計 Date（ローカル正午）として読む。日付演算の足場にする。 */
function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  // 正午を使うのは、date-fns の日付演算が DST 遷移日でも日付をまたがないようにするため。
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0);
}

/** 壁時計 Date を `YYYY-MM-DD` へ。`toZonedDateKey` と違い TZ 変換を挟まない。 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 期間の先頭日（壁時計）を粒度ごとに求める。 */
function resolvePeriodStartDay(
  anchor: Date,
  granularity: ReportGranularity,
  weekStartsOn: ReportWeekStartsOn,
): Date {
  switch (granularity) {
    case 'week':
      return dfStartOfWeek(anchor, { weekStartsOn });
    case 'month':
      return new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12, 0, 0, 0);
    case 'year':
      return new Date(anchor.getFullYear(), 0, 1, 12, 0, 0, 0);
  }
}

/**
 * 時間帯の 6 バケット（仕様 §6-4）。**配列の順序がそのまま棒の並び**になる。
 *
 * 深夜（0–300）が最後なのは「1 日の先頭だが、読み手にとっては 1 日の終わり」だから
 * （仕様の並び）。区間はすべて半開 `[start, end)` で、1440 分を隙間なく覆う。
 */
export const REPORT_TIME_OF_DAY_BUCKETS = [
  { key: 'morning', startMinute: 300, endMinute: 540 },
  { key: 'lateMorning', startMinute: 540, endMinute: 720 },
  { key: 'midday', startMinute: 720, endMinute: 900 },
  { key: 'afternoon', startMinute: 900, endMinute: 1080 },
  { key: 'evening', startMinute: 1080, endMinute: 1440 },
  { key: 'night', startMinute: 0, endMinute: 300 },
] as const;

/**
 * ブロックを時間帯 6 バケットへ按分する（分）。
 *
 * **0 時またぎは日境界で分割してから按分する。** 23:30–翌 1:00 の記録は「夜 30 分 +
 * 深夜 60 分」であって、どちらか一方へ丸ごと寄せない（#2576 の日別按分と同じ規則）。
 * 壁時計での位置が要るので、境界はユーザーの timezone で解く。
 */
export function distributeToTimeOfDay(
  blockStartAt: string,
  blockEndAt: string,
  timezone: string,
): number[] {
  return distributeToDayMinuteRanges(
    blockStartAt,
    blockEndAt,
    timezone,
    REPORT_TIME_OF_DAY_BUCKETS,
  );
}

/**
 * 1 時間刻みの 24 バケット（`[h:00, h+1:00)`）。時間の使い方の「時間帯の分布」が使う。
 * 詳細パネルの 6 バケットより細かいのは、期間全体を 1 枚で見る面だから。
 */
export const REPORT_HOUR_BUCKETS = Array.from({ length: 24 }, (_, hour) => ({
  key: String(hour),
  startMinute: hour * 60,
  endMinute: (hour + 1) * 60,
}));

/** ブロックを 1 時間刻みの 24 バケットへ按分する（分）。規則は `distributeToTimeOfDay` と同じ。 */
export function distributeToHours(
  blockStartAt: string,
  blockEndAt: string,
  timezone: string,
): number[] {
  return distributeToDayMinuteRanges(blockStartAt, blockEndAt, timezone, REPORT_HOUR_BUCKETS);
}

/**
 * ブロックを壁時計の分範囲（`[startMinute, endMinute)`）のバケットへ按分する（分）。
 *
 * **0 時またぎは日境界で分割してから按分する。** 壁時計での位置が要るので、境界はユーザーの
 * timezone で解く。
 */
function distributeToDayMinuteRanges(
  blockStartAt: string,
  blockEndAt: string,
  timezone: string,
  buckets: readonly { startMinute: number; endMinute: number }[],
): number[] {
  const totals = buckets.map(() => 0);
  const startMs = Date.parse(blockStartAt);
  const endMs = Date.parse(blockEndAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return totals;

  // 記録が跨ぐ壁時計日を 1 日ずつ辿る。年粒度でも 1 ブロックの長さは高々数日なので、
  // 日数で回して問題ない（暴走を避けるため上限を置く）。
  let dayKey = toZonedDateKey(new Date(startMs), timezone);
  for (let index = 0; index < MAX_TIME_OF_DAY_DAYS; index += 1) {
    const dayStartMs = zonedDayStart(dayKey, timezone).getTime();
    const nextDayKey = formatDateKey(addDays(parseDateKey(dayKey), 1));
    const dayEndMs = zonedDayStart(nextDayKey, timezone).getTime();

    const segmentStart = Math.max(startMs, dayStartMs);
    const segmentEnd = Math.min(endMs, dayEndMs);

    if (segmentEnd > segmentStart) {
      // その日の 00:00 からの経過分で位置を測る（DST の日は 1 日が 23 / 25 時間になるが、
      // 分布の見た目に効く差ではないので公称値で扱う）
      const fromMinute = (segmentStart - dayStartMs) / 60_000;
      const toMinute = (segmentEnd - dayStartMs) / 60_000;

      buckets.forEach((bucket, bucketIndex) => {
        const overlap =
          Math.min(toMinute, bucket.endMinute) - Math.max(fromMinute, bucket.startMinute);
        if (overlap > 0) totals[bucketIndex] = (totals[bucketIndex] ?? 0) + overlap;
      });
    }

    if (dayEndMs >= endMs) break;
    dayKey = nextDayKey;
  }

  return totals;
}

/** `distributeToTimeOfDay` が辿る壁時計日の上限。1 ブロックがこれを超える長さになる想定は無い。 */
const MAX_TIME_OF_DAY_DAYS = 400;

/** 期間の終端日（壁時計、含まない）を粒度ごとに求める。 */
function resolvePeriodEndDay(startDay: Date, granularity: ReportGranularity): Date {
  switch (granularity) {
    case 'week':
      return addDays(startDay, 7);
    case 'month':
      return addMonths(startDay, 1);
    case 'year':
      return addYears(startDay, 1);
  }
}

/**
 * 期間内の列（bucket）を組む。
 *
 * - 週: 7 日。曜日順は `weekStartsOn` に従う
 * - 月: 週の列。**先頭列は月初日から始まる**（前月へはみ出さない）ので、最初の列だけ
 *   7 日未満になりうる。最終列も同様に月末で切る
 * - 年: 12 か月
 */
function buildBuckets(
  startDay: Date,
  endDay: Date,
  granularity: ReportGranularity,
  timezone: string,
  weekStartsOn: ReportWeekStartsOn,
): ReportBucket[] {
  const buckets: ReportBucket[] = [];

  if (granularity === 'week') {
    for (let index = 0; index < 7; index += 1) {
      const day = addDays(startDay, index);
      const next = addDays(startDay, index + 1);
      buckets.push(toBucket(formatDateKey(day), day, next, timezone));
    }
    return buckets;
  }

  if (granularity === 'year') {
    for (let index = 0; index < 12; index += 1) {
      const monthStart = addMonths(startDay, index);
      const monthEnd = addMonths(startDay, index + 1);
      const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
      buckets.push(toBucket(key, monthStart, monthEnd, timezone));
    }
    return buckets;
  }

  // 月粒度: 週の列。月初日を先頭列の開始にし、以降は週境界で割る。
  let cursor = startDay;
  while (cursor < endDay) {
    const weekBoundary = addWeeks(dfStartOfWeek(cursor, { weekStartsOn }), 1);
    const next = weekBoundary < endDay ? weekBoundary : endDay;
    buckets.push(toBucket(formatDateKey(cursor), cursor, next, timezone));
    cursor = next;
  }
  return buckets;
}

function toBucket(key: string, startDay: Date, endDay: Date, timezone: string): ReportBucket {
  return {
    key,
    startAt: zonedDayStart(formatDateKey(startDay), timezone).toISOString(),
    endAt: zonedDayStart(formatDateKey(endDay), timezone).toISOString(),
  };
}

/** 期間の公称の長さ（分）。週は固定、月・年は実日数 × 1440。 */
function resolveLengthMinutes(
  startDay: Date,
  endDay: Date,
  granularity: ReportGranularity,
): number {
  if (granularity === 'week') return MINUTES_PER_WEEK;
  // 壁時計の日数を数える（DST で時間がずれても日数は変わらない）。正午基準なので端数は出ない。
  const dayCount = Math.round((endDay.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000));
  return dayCount * MINUTES_PER_DAY;
}

/**
 * レポートの表示期間を解決する。
 *
 * @param anchorDate - 期間を含む任意の日（`YYYY-MM-DD`。ユーザーの壁時計日付）
 * @param granularity - 週 / 月 / 年
 * @param timezone - ユーザーの timezone（IANA 名）
 * @param weekStartsOn - 週の開始曜日（0 / 1 / 6）

 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function resolveReportRange(
  anchorDate: string,
  granularity: ReportGranularity,
  timezone: string,
  weekStartsOn: ReportWeekStartsOn,
): ReportRange {
  const anchor = parseDateKey(anchorDate);
  const startDay = resolvePeriodStartDay(anchor, granularity, weekStartsOn);
  const endDay = resolvePeriodEndDay(startDay, granularity);

  return {
    startAt: zonedDayStart(formatDateKey(startDay), timezone).toISOString(),
    endAt: zonedDayStart(formatDateKey(endDay), timezone).toISOString(),
    lengthMinutes: resolveLengthMinutes(startDay, endDay, granularity),
    buckets: buildBuckets(startDay, endDay, granularity, timezone, weekStartsOn),
  };
}

/**
 * 期間を 1 つ前後へずらした anchor 日付を返す（ヘッダーの `‹ ›`）。
 *
 * カレンダーの `navigateRelative` は calendar の viewType 基準で動くため、レポートの
 * 粒度とは食い違う。レポートの期間移動はこの関数を通す。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function shiftReportAnchor(
  anchorDate: string,
  granularity: ReportGranularity,
  direction: 1 | -1,
): string {
  const anchor = parseDateKey(anchorDate);
  switch (granularity) {
    case 'week':
      return formatDateKey(addWeeks(anchor, direction));
    case 'month':
      return formatDateKey(addMonths(anchor, direction));
    case 'year':
      return formatDateKey(addYears(anchor, direction));
  }
}

/**
 * 前期間（Δ 表示用）。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function resolvePreviousReportRange(
  anchorDate: string,
  granularity: ReportGranularity,
  timezone: string,
  weekStartsOn: ReportWeekStartsOn,
): ReportRange {
  return resolveReportRange(
    shiftReportAnchor(anchorDate, granularity, -1),
    granularity,
    timezone,
    weekStartsOn,
  );
}

/**
 * 指定 timezone における「今日」の日付キー。既定の anchor を組むのに使う。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function todayReportAnchor(timezone: string, now: Date = new Date()): string {
  return toZonedDateKey(now, timezone);
}

/**
 * ブロックを期間へ clip した長さ（分）。範囲外なら 0。
 *
 * 選択クエリ（`start_at < end AND end_at > start`）で拾った行は境界を跨ぎうるため、
 * 計上する前に必ずここを通す。#2426 は clip を欠いたことで、跨いだブロックの全時間を
 * 片側の期間へ帰属させていた。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function clipMinutes(
  blockStartAt: string,
  blockEndAt: string,
  rangeStartAt: string,
  rangeEndAt: string,
): number {
  const start = Math.max(Date.parse(blockStartAt), Date.parse(rangeStartAt));
  const end = Math.min(Date.parse(blockEndAt), Date.parse(rangeEndAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 60000;
}

/**
 * ブロックを各 bucket へ按分した分数の配列（`buckets` と同 index）。
 *
 * 0 時またぎ（就寝など）はここで日境界に分割される。**ブロック自体は分割しない** —
 * 数値の帰属だけを按分する（仕様 §1）。合計は `clipMinutes` と一致する。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */
export function distributeToBuckets(
  blockStartAt: string,
  blockEndAt: string,
  buckets: readonly ReportBucket[],
): number[] {
  return buckets.map((bucket) =>
    clipMinutes(blockStartAt, blockEndAt, bucket.startAt, bucket.endAt),
  );
}
