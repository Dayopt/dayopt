import { collectQueryPages } from '@/lib/database/collect-query-pages';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { databaseTables, type Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

/**
 * レポート集計の行取得。
 *
 * **選択は半開区間の重なりで書く**（`start_at < rangeEnd AND end_at > rangeStart`）。
 * `start_at` だけで絞ると、期間境界を跨ぐブロック（日曜 23 時就寝 → 月曜 7 時起床）が
 * 開始側の期間へ全時間帰属し、跨いだ先からは丸ごと消える。これは
 * 取得後の clip は共通導出関数が行う。
 *
 * `archived_at` では絞らない。アーカイブは未来にだけ効く操作で、過去の記録が消えるわけでは
 * ないため、期間内にインクがあるアクティビティは通常どおり集計対象にする。
 *
 * @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。
 */

export type ReportFetchClient = SupabaseClient<Database>;

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportRangeInput {
  startAt: string;
  endAt: string;
}

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportPlanRow {
  id: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
}

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportRecordRow {
  id: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  fulfillment: string | null;
  /** `'manual'` / `'from_plan'` / `'auto_migrated'` など。1 件あたりの中央値の母集団を絞るのに使う。 */
  source: string;
}

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportActivityRow {
  id: string;
  name: string;
  category_id: string | null;
  archived_at: string | null;
}

/** @public 直接 import されず tRPC の推論経由で使われるため、knip には見えない。 */
export interface ReportCategoryRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

function throwDatabaseError(error: unknown, operation: string): never {
  throw captureUnexpectedDatabaseError(error, { feature: 'report', operation });
}

/** 期間に重なる Record を取る。長さの clip は呼び出し側で行う。 */
export async function fetchReportRecords(
  supabase: ReportFetchClient,
  userId: string,
  range: ReportRangeInput,
): Promise<ReportRecordRow[]> {
  const query = supabase
    .from(databaseTables.records)
    .select('id, activity_id, start_at, end_at, fulfillment, source')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('start_at', range.endAt)
    .gt('end_at', range.startAt);

  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));
  if (error) throwDatabaseError(error, 'fetch_report_records');
  return data ?? [];
}

/** 期間に重なる Plan を取る。 */
export async function fetchReportPlans(
  supabase: ReportFetchClient,
  userId: string,
  range: ReportRangeInput,
): Promise<ReportPlanRow[]> {
  const query = supabase
    .from(databaseTables.plans)
    .select('id, activity_id, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('start_at', range.endAt)
    .gt('end_at', range.startAt);

  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));
  if (error) throwDatabaseError(error, 'fetch_report_plans');
  return data ?? [];
}

/** アクティビティ全件。アーカイブ済みも含める（期間内にインクがあれば表示するため）。 */
export async function fetchReportActivities(
  supabase: ReportFetchClient,
  userId: string,
): Promise<ReportActivityRow[]> {
  const { data, error } = await supabase
    .from(databaseTables.activities)
    .select('id, name, category_id, archived_at')
    .eq('user_id', userId);

  if (error) throwDatabaseError(error, 'fetch_report_activities');
  return data ?? [];
}

/** カテゴリー全件。色とアイコンは表示側が semantic token へ写す。 */
export async function fetchReportCategories(
  supabase: ReportFetchClient,
  userId: string,
): Promise<ReportCategoryRow[]> {
  const { data, error } = await supabase
    .from(databaseTables.categories)
    .select('id, name, color, icon')
    .eq('user_id', userId);

  if (error) throwDatabaseError(error, 'fetch_report_categories');
  return data ?? [];
}

// =============================================================================
// 詳細パネル（#2581）
// =============================================================================

/** 明細に出す 1 箱の上限。パネルは読み物で、全件スクロールさせる面ではない（仕様 §6-6）。 */
export const REPORT_DETAIL_RECORD_LIMIT = 200;

export interface ReportDetailRecordRow {
  id: string;
  title: string;
  note: string | null;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  fulfillment: string | null;
  /** `'manual'` / `'from_plan'` / `'auto_migrated'` など。中央値の除外判定に使う。 */
  source: string;
}

/**
 * 1 アクティビティの記録を期間分だけ取る（詳細パネル）。
 *
 * `fetchReportRecords` と違い **title / note を持ち、DB 側で `activity_id` を絞る**。
 * 期間集計は全アクティビティを 1 往復で取るのが正しいが、詳細は 1 行ぶんしか要らないので、
 * 同じ形にすると年粒度で無駄が大きい。
 *
 * `activityId` が `null` は「アクティビティ未設定の記録」で、`.is()` を使う（`.eq(null)` は
 * PostgREST では `IS NULL` にならない）。
 */
export async function fetchReportDetailRecords(
  supabase: ReportFetchClient,
  userId: string,
  activityId: string | null,
  range: ReportRangeInput,
): Promise<ReportDetailRecordRow[]> {
  const base = supabase
    .from(databaseTables.records)
    .select('id, title, note, activity_id, start_at, end_at, fulfillment, source')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('start_at', range.endAt)
    .gt('end_at', range.startAt);

  const query =
    activityId === null ? base.is('activity_id', null) : base.eq('activity_id', activityId);
  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));

  if (error) throwDatabaseError(error, 'fetch_report_detail_records');
  return data ?? [];
}

/** 1 アクティビティの予定を期間分だけ取る（予定比・未消化の判定に使う）。 */
export async function fetchReportDetailPlans(
  supabase: ReportFetchClient,
  userId: string,
  activityId: string | null,
  range: ReportRangeInput,
): Promise<ReportPlanRow[]> {
  const base = supabase
    .from(databaseTables.plans)
    .select('id, activity_id, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('start_at', range.endAt)
    .gt('end_at', range.startAt);

  const query =
    activityId === null ? base.is('activity_id', null) : base.eq('activity_id', activityId);
  const { data, error } = await collectQueryPages((from, to) => query.order('id').range(from, to));

  if (error) throwDatabaseError(error, 'fetch_report_detail_plans');
  return data ?? [];
}
