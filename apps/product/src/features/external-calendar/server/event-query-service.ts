import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { databaseTables, type Database } from '@/lib/database';
import {
  calendarSelectionKey,
  GHOST_CONNECTION_STATUS,
  GHOST_EVENT_STATUS,
  GHOST_QUERY_BATCH_SIZE,
  GHOST_QUERY_MAX_BATCHES,
} from '@/lib/external-calendar-ghost';
import { logger } from '@/lib/logger';
import { captureUnexpectedError } from '@/lib/sentry';

import { ExternalCalendarServiceError } from './external-calendar-service-error';

/**
 * calendar 画面の ghost 表示が読むミラーの読み取り経路。
 *
 * 導出条件は「ミラー − cancelled − dismissed − 孤児 − plans/records が参照済み」。
 * 書き込み側（`sync-service` / `event-pruning`）と違い **authenticated client で動き、RLS を
 * 防御の一枚目として残す**。service_role を読み取りへ持ち込まない。
 *
 * - **除外は allowlist で書く**。`status` は CHECK enum の無い free text なので、`!= 'cancelled'`
 *   だと将来 provider を足して第 3 の値が入った時に未知の状態が黙って画面へ出る
 * - **`connection_id IS NULL` を弾く**。disconnect は plans/records から参照済みのミラー行を
 *   `connection_id = NULL` の歴史的アンカーとして残す。参照済みなら anti-join で落ちるが、
 *   prune が batch 上限や race で取りこぼした「未参照の孤児」は切断済みアカウントの予定として
 *   復活しうる
 * - **anti-join は soft-delete を無視する**（`event-pruning` とは意図的に違う）。あちらが
 *   `deleted_at` で絞らないのは FK が NO ACTION で、参照行を消すと 23503 になるため。表示に
 *   同じ意味論を持ち込むと、ゴミ箱に入れた plan / record が ghost を永久に隠す
 * - **keyset ページングで範囲を取り切る**。単発 `.limit()` は PostgREST が order 無しで順序を
 *   保証しないため、上限に当たった瞬間「範囲内の予定がランダムに消える」形になる
 * - **選択解除済みカレンダーの historical anchor も除外する**。`updateSelectedCalendars` は
 *   参照済み（soft-delete 済み含む）ミラー行を `connection_id` 付きのまま残すため、
 *   `connection_id IS NOT NULL` だけでは選択解除後も ghost として復活しうる。現在も
 *   `calendar_connection_calendars` に存在する `(connection_id, provider_calendar_id)` だけを通す
 */

interface ExternalCalendarEventSummary {
  id: string;
  /** provider 側が空文字を許すため、表示側でフォールバックする。 */
  title: string | null;
  calendarName: string | null;
  startAt: string;
  endAt: string;
}

type EventQueryClient = SupabaseClient<Database>;

interface EventRangeInput {
  startAt: string;
  endAt: string;
}

interface CandidateRow {
  id: string;
  title: string | null;
  calendar_name: string | null;
  connection_id: string | null;
  provider_calendar_id: string;
  start_at: string | null;
  end_at: string | null;
}

/**
 * plans / records から、与えた id を参照している external_calendar_event_id を集める。
 *
 * `event-pruning` の同名関数と違い **soft-delete 済みの参照は数えない**（上のコメント参照）。
 * RLS があっても `user_id` を明示するのは、`external_calendar_events_user_time_idx` への到達を
 * RLS の initplan 展開に依存させないため。
 */
async function loadReferencedEventIds(
  supabase: EventQueryClient,
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

    if (error) {
      throw new ExternalCalendarServiceError(
        'FETCH_FAILED',
        'Failed to check which external calendar events are already converted',
        { cause: error },
      );
    }

    for (const row of data ?? []) {
      if (row.external_calendar_event_id !== null) referenced.add(row.external_calendar_event_id);
    }
  }

  return referenced;
}

function hasTimeRange(
  row: CandidateRow,
): row is CandidateRow & { start_at: string; end_at: string } {
  // active_shape CHECK が非 cancelled 行では NOT NULL を保証するが、生成型は nullable なので
  // 実行時にも落とす。
  return row.start_at !== null && row.end_at !== null;
}

/**
 * ユーザーの `active` な接続 id を返す。
 *
 * `reauth_required` の接続は同期が止まっているため、そのミラーは最後に成功した時点のまま
 * 更新されなくなる。selection の allowlist をこの集合で絞ることで、再認証待ちの接続に属する
 * 古い ghost を fail closed で隠す。
 */
async function loadActiveConnectionIds(
  supabase: EventQueryClient,
  userId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from(databaseTables.calendarConnections)
    .select('id')
    .eq('user_id', userId)
    .eq('status', GHOST_CONNECTION_STATUS);

  if (error) {
    throw new ExternalCalendarServiceError(
      'FETCH_FAILED',
      'Failed to load active calendar connections for ghost filtering',
      { cause: error },
    );
  }

  return new Set((data ?? []).map((row) => row.id));
}

/**
 * ユーザーが現在選択しているカレンダーの `(connection_id, provider_calendar_id)` 集合を返す。
 *
 * `calendar_connection_calendars` は 1 接続あたり最大 50 件・ユーザーの接続数も少数なので、
 * バッチごとではなく `listGhostEvents` 呼び出しにつき 1 回だけ読む。`active` でない接続の選択行は
 * 含めない（`loadActiveConnectionIds` 参照）。
 */
async function loadSelectedCalendarKeys(
  supabase: EventQueryClient,
  userId: string,
): Promise<Set<string>> {
  const activeConnectionIds = await loadActiveConnectionIds(supabase, userId);
  if (activeConnectionIds.size === 0) return new Set();

  const { data, error } = await supabase
    .from(databaseTables.calendarConnectionCalendars)
    .select('connection_id, provider_calendar_id')
    .eq('user_id', userId)
    .in('connection_id', [...activeConnectionIds]);

  if (error) {
    throw new ExternalCalendarServiceError(
      'FETCH_FAILED',
      'Failed to load selected calendars for ghost filtering',
      { cause: error },
    );
  }

  return new Set(
    (data ?? []).map((row) => calendarSelectionKey(row.connection_id, row.provider_calendar_id)),
  );
}

/**
 * 表示範囲に重なる ghost 候補を返す。範囲は半開区間で扱う。
 *
 * batch 上限に達した場合は **エラーにする**（部分結果を返さない。Sentry にも出す）。
 * 3,000 件は共有・会議室カレンダーを多数選ぶと届きうるため、到達は「異常」ではなく
 * fail closed で扱う既知の上限として位置づける。
 */
export async function listGhostEvents(
  supabase: EventQueryClient,
  userId: string,
  range: EventRangeInput,
): Promise<ExternalCalendarEventSummary[]> {
  const selectedCalendarKeys = await loadSelectedCalendarKeys(supabase, userId);

  const events: ExternalCalendarEventSummary[] = [];
  let cursor: string | null = null;

  for (let batch = 0; batch < GHOST_QUERY_MAX_BATCHES; batch += 1) {
    let query = supabase
      .from(databaseTables.externalCalendarEvents)
      .select('id, title, calendar_name, connection_id, provider_calendar_id, start_at, end_at')
      .eq('user_id', userId)
      .eq('status', GHOST_EVENT_STATUS)
      .is('dismissed_at', null)
      .not('connection_id', 'is', null)
      .lt('start_at', range.endAt)
      .gt('end_at', range.startAt);

    // 初回ページは cursor が無い。UUID 列に空文字を渡すと PostgREST 側で invalid UUID になり
    // 予定の有無にかかわらず取得が丸ごと失敗するため、2 ページ目以降にだけ条件を足す。
    if (cursor !== null) {
      query = query.gt('id', cursor);
    }

    const { data, error } = await query
      .order('id', { ascending: true })
      .limit(GHOST_QUERY_BATCH_SIZE);

    if (error) {
      throw new ExternalCalendarServiceError(
        'FETCH_FAILED',
        'Failed to load external calendar events',
        { cause: error },
      );
    }

    const candidates: CandidateRow[] = data ?? [];
    if (candidates.length === 0) return events;

    const referenced = await loadReferencedEventIds(
      supabase,
      userId,
      candidates.map((row) => row.id),
    );

    for (const row of candidates) {
      if (referenced.has(row.id)) continue;
      if (!hasTimeRange(row)) continue;
      if (row.connection_id === null) continue;
      if (
        !selectedCalendarKeys.has(calendarSelectionKey(row.connection_id, row.provider_calendar_id))
      )
        continue;

      events.push({
        id: row.id,
        title: row.title,
        calendarName: row.calendar_name,
        startAt: row.start_at,
        endAt: row.end_at,
      });
    }

    cursor = candidates[candidates.length - 1]?.id ?? cursor;
    if (candidates.length < GHOST_QUERY_BATCH_SIZE) return events;
  }

  logger.warn('[calendar-ghost] stopped at the batch limit', { batches: GHOST_QUERY_MAX_BATCHES });
  // 上限値は logger 側にだけ出す。`CaptureErrorContext` は string キーしか持たない。
  captureUnexpectedError(new Error('external calendar ghost query hit the batch limit'), {
    feature: 'external_calendar',
    operation: 'ghost_query_batch_limit',
  });
  // 黙って部分結果を返すと「範囲内の予定が UUID 順で再現性なく欠落する」形になる。fail closed で
  // 明示エラーにし、client 側は空表示に倒す（`useExternalCalendarEvents` の isError 分岐）。
  throw new ExternalCalendarServiceError(
    'FETCH_FAILED',
    'external calendar ghost query hit the batch limit',
  );
}
