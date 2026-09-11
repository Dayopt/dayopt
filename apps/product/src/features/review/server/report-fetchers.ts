import { collectQueryPages } from '@/lib/database/collect-query-pages';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { databaseTables, type Database } from '@/lib/database';
import {
  calendarSelectionKey,
  EXTERNAL_CALENDAR_WINDOW_RADIUS_MS,
  GHOST_CONNECTION_STATUS,
  GHOST_EVENT_STATUS,
  GHOST_QUERY_BATCH_SIZE,
  GHOST_QUERY_MAX_BATCHES,
} from '@/lib/external-calendar-ghost';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';

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
    .select('id, activity_id, start_at, end_at, fulfillment')
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
// 未変換の外部予定（4 章 2 行目）
// =============================================================================

export interface ReportGhostEventRow {
  id: string;
  start_at: string;
}

interface GhostCandidateRow {
  id: string;
  connection_id: string | null;
  provider_calendar_id: string;
  start_at: string | null;
}

/**
 * カレンダー画面が ghost として描く行の選択条件を、レポート側でも同じ形で組む。
 *
 * **`external-calendar` の `listGhostEvents` を呼べない**（feature 間の deep import は
 * eslint が error、barrel は client 用で `server-only` を通せない）ため、導出条件
 * 「ミラー − cancelled − dismissed − 孤児 − 選択解除 − plans/records が参照済み」を
 * ここでも同じ順序で書く。純粋な定数・選択キーは `lib/external-calendar-ghost` を共有し、
 * DB 選択条件の一致は `lib/test/external-calendar-ghost-contract.test.ts` で検証する。
 * **条件を 1 つでも緩めると、4 章の「N 件」を押した先の
 * カレンダーに ghost が 1 つも無い**という行き止まりになる。
 *
 * レポートは同期と同じ ±90 日を数え、窓外に残る古い行は含めない。カレンダーの
 * 最大62日より広いため、共有の取得予算（150 × 20件）に達すると数え漏れる可能性がある。
 *
 * `listGhostEvents` との意図的な違いは 1 点だけ: **バッチ上限に当たっても throw しない**。
 * あちらは「範囲内の予定が再現性なく欠落する」ことを避けるための fail closed だが、
 * こちらは 4 章 1 行のための件数で、ここで throw するとレポート全体（1〜4 章）が
 * 落ちる。数え漏れの方が実害が小さいので、そこまでの件数を返す。
 */
export async function fetchReportUnconvertedExternalEvents(
  supabase: ReportFetchClient,
  userId: string,
  now: Date,
): Promise<ReportGhostEventRow[]> {
  const selectedCalendarKeys = await loadSelectedGhostCalendarKeys(supabase, userId);
  if (selectedCalendarKeys.size === 0) return [];

  const windowStart = new Date(now.getTime() - EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString();
  const windowEnd = new Date(now.getTime() + EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString();

  const events: ReportGhostEventRow[] = [];
  let cursor: string | null = null;

  for (let batch = 0; batch < GHOST_QUERY_MAX_BATCHES; batch += 1) {
    let query = supabase
      .from(databaseTables.externalCalendarEvents)
      .select('id, connection_id, provider_calendar_id, start_at')
      .eq('user_id', userId)
      .eq('status', GHOST_EVENT_STATUS)
      .is('dismissed_at', null)
      .not('connection_id', 'is', null)
      .lt('start_at', windowEnd)
      .gt('end_at', windowStart);

    // 初回は cursor 無し。UUID 列に空文字を渡すと PostgREST 側で invalid UUID になる。
    if (cursor !== null) query = query.gt('id', cursor);

    const { data, error } = await query
      .order('id', { ascending: true })
      .limit(GHOST_QUERY_BATCH_SIZE);

    if (error) throwDatabaseError(error, 'fetch_report_external_events');

    const candidates: GhostCandidateRow[] = data ?? [];
    if (candidates.length === 0) return events;

    const referenced = await loadGhostReferencedEventIds(
      supabase,
      userId,
      candidates.map((row) => row.id),
    );

    for (const row of candidates) {
      if (referenced.has(row.id)) continue;
      if (row.start_at === null || row.connection_id === null) continue;
      if (
        !selectedCalendarKeys.has(calendarSelectionKey(row.connection_id, row.provider_calendar_id))
      ) {
        continue;
      }
      events.push({ id: row.id, start_at: row.start_at });
    }

    cursor = candidates[candidates.length - 1]?.id ?? cursor;
    if (candidates.length < GHOST_QUERY_BATCH_SIZE) return events;
  }

  // 上限に当たったら「数え切れたぶん」で返す（上のコメント参照）。カレンダー側と違い
  // ここで落とすとレポート全体が読めなくなる。ただし **黙って少なく数えるのは避ける** —
  // 件数が実際より少ないまま出続けるので、運用側が気づけるよう Sentry にも残す
  // （`event-query-service.ts` は throw する側で同じ通知を出している）。
  logger.warn('[report-ghost] stopped at the batch limit', { batches: GHOST_QUERY_MAX_BATCHES });
  captureUnexpectedError(new Error('report ghost count hit the batch limit'), {
    feature: 'report',
    operation: 'ghost_count_batch_limit',
  });
  return events;
}

/** ユーザーがいま選択している `(connection_id, provider_calendar_id)`。active な接続のみ。 */
async function loadSelectedGhostCalendarKeys(
  supabase: ReportFetchClient,
  userId: string,
): Promise<Set<string>> {
  const { data: connections, error: connectionError } = await supabase
    .from(databaseTables.calendarConnections)
    .select('id')
    .eq('user_id', userId)
    .eq('status', GHOST_CONNECTION_STATUS);

  if (connectionError) throwDatabaseError(connectionError, 'fetch_report_calendar_connections');

  const activeConnectionIds = (connections ?? []).map((row) => row.id);
  if (activeConnectionIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from(databaseTables.calendarConnectionCalendars)
    .select('connection_id, provider_calendar_id')
    .eq('user_id', userId)
    .in('connection_id', activeConnectionIds);

  if (error) throwDatabaseError(error, 'fetch_report_selected_calendars');

  return new Set(
    (data ?? []).map((row) => calendarSelectionKey(row.connection_id, row.provider_calendar_id)),
  );
}

/**
 * plans / records が既に参照しているミラー行の id。
 *
 * soft-delete 済みの参照は数えない（ゴミ箱に入れた plan / record が ghost を永久に隠すのを
 * 避ける。`event-query-service.ts` と同じ判断）。
 */
async function loadGhostReferencedEventIds(
  supabase: ReportFetchClient,
  userId: string,
  ids: string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (const table of [databaseTables.plans, databaseTables.records] as const) {
    const { data, error } = await supabase
      .from(table)
      .select('external_calendar_event_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .in('external_calendar_event_id', ids);

    if (error) throwDatabaseError(error, 'fetch_report_converted_external_events');

    for (const row of data ?? []) {
      if (row.external_calendar_event_id !== null) referenced.add(row.external_calendar_event_id);
    }
  }

  return referenced;
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
