import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import { databaseTables, type Database } from '@/lib/database';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';

/**
 * ミラー（`external_calendar_events`）から「plans / records に参照されていない行」だけを
 * delete する共有 helper。
 *
 * 3 つの呼び出し点（sync の window prune / 選択解除の掃除 / disconnect の全削除）が同じ
 * anti-join を必要とし、その不変条件はデータ欠損に直結するので 1 箇所に集約する:
 *
 * - **soft-delete 済みの plan / record も参照とみなす**。`external_calendar_event_id` の FK は
 *   ON DELETE 句なし（NO ACTION）なので、`deleted_at` で絞ると参照行の DELETE が 23503 で落ちる
 * - **候補が空 / 全参照済みなら delete を発行しない**。空リストへの delete が全削除にならないよう、
 *   常に非空の id リストだけを `.in('id', …)` に渡す
 * - **keyset ページング**で `max_rows=1000` と URL 長 8192B（UUID 約 210 件）の両方を避ける
 * - service_role は RLS を bypass するので、delete にも `user_id` を明示的に添える
 */

/** sync / connection service と同じ外部呼び出しタイムアウト（`lib/supabase/oauth.ts`）。 */
const DB_REQUEST_TIMEOUT_MS = 15_000;

/** 1 バッチあたり件数。max_rows=1000 と URL 長 8192B に触れない。 */
const PRUNE_BATCH_SIZE = 150;

/**
 * window / calendars scope のバッチ上限。150 × 40 = 6,000 件で ±90 日 window の想定を
 * 大きく超える。到達は prune 条件かページングが壊れている異常のサインとして扱い throw する。
 */
const MAX_PRUNE_BATCHES = 40;

/**
 * connection scope（disconnect の全削除）のバッチ上限。この経路は時間窓を持たない
 * 一回限りの終端操作なので、参照済み行（歴史的アンカー）が大量に混ざっていても
 * 最終的に完走できる必要がある。上限到達時に throw するようになった結果（#1988）、
 * 上限が低いと再試行しても同じ場所で毎回止まり、connection を永久に切断できなくなる
 * （Codex 指摘、#2000）。150 × 4,000 = 600,000 件は現実的な接続では到達しない値にし、
 * 真のページングバグに対する backstop としてだけ機能させる。
 */
const MAX_PRUNE_BATCHES_CONNECTION_SCOPE = 4_000;

/**
 * 掃除する行の絞り込み条件。
 *
 * - `window`: sync の window prune。`end_at < notBefore OR start_at > notAfter`
 * - `calendars`: 選択解除。指定 provider_calendar_id の行だけ（空なら no-op）
 * - `connection`: disconnect。接続配下の全行
 */
type EventPruneScope =
  | { kind: 'window'; notBefore: string; notAfter: string }
  | { kind: 'calendars'; providerCalendarIds: string[] }
  | { kind: 'connection' };

/**
 * service_role client が触れる surface を anti-join に必要な 3 テーブルへ narrow する。
 * plans / records は参照判定のため SELECT のみ使う。
 */
type EventPruningDatabase = {
  public: {
    Tables: Pick<Database['public']['Tables'], 'external_calendar_events' | 'plans' | 'records'>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type EventPruningClient = SupabaseClient<EventPruningDatabase>;

function createEventPruningClient(): EventPruningClient {
  return createClient<EventPruningDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
        }),
    },
  });
}

/** plans / records の両方から、与えた id を参照している external_calendar_event_id を集める。 */
async function loadReferencedEventIds(
  db: EventPruningClient,
  userId: string,
  ids: string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (const table of [databaseTables.plans, databaseTables.records] as const) {
    const { data, error } = await db
      .from(table)
      .select('external_calendar_event_id')
      .eq('user_id', userId)
      .in('external_calendar_event_id', ids);

    if (error) throw error;

    for (const row of data ?? []) {
      if (row.external_calendar_event_id !== null) referenced.add(row.external_calendar_event_id);
    }
  }

  return referenced;
}

/**
 * scope に一致する未参照ミラー行を anti-join で delete する。
 *
 * **既知の想定内レース（23503: select と delete の間に plan が作られる）を除き、失敗は
 * すべて throw する。** 呼び出し元がここまでの成功を守りたいか（sync の window prune・選択解除
 * の即時掃除は best-effort で catch する）、fail-closed に倒したいか（disconnect は catch せず
 * connection 削除を止める）を選べるようにするため、ここでは判断しない。
 *
 * throw する失敗: select 失敗、参照読み取り失敗、23503 以外の delete 失敗、
 * batch 上限到達（部分的にしか掃除できていない状態を「成功」として返さない）。
 */
export async function deleteUnreferencedEvents(params: {
  userId: string;
  connectionId: string;
  scope: EventPruneScope;
}): Promise<void> {
  const { userId, connectionId, scope } = params;

  // 選択解除で外したカレンダーが 0 件なら掃除対象も無い。空 `.in()` を撃たない。
  if (scope.kind === 'calendars' && scope.providerCalendarIds.length === 0) return;

  const db = createEventPruningClient();
  let cursor: string | null = null;
  const batchLimit =
    scope.kind === 'connection' ? MAX_PRUNE_BATCHES_CONNECTION_SCOPE : MAX_PRUNE_BATCHES;

  for (let batch = 0; batch < batchLimit; batch += 1) {
    let query = db
      .from(databaseTables.externalCalendarEvents)
      .select('id')
      .eq('user_id', userId)
      .eq('connection_id', connectionId);

    if (scope.kind === 'window') {
      query = query.or(`end_at.lt.${scope.notBefore},start_at.gt.${scope.notAfter}`);
    } else if (scope.kind === 'calendars') {
      query = query.in('provider_calendar_id', scope.providerCalendarIds);
    }

    // 初回ページは cursor が無い。UUID 列に空文字を渡すと PostgREST 側で invalid UUID になり、
    // 削除対象の有無にかかわらず取得が丸ごと失敗するため、2 ページ目以降にだけ条件を足す。
    if (cursor !== null) {
      query = query.gt('id', cursor);
    }

    const { data: candidates, error: selectError } = await query
      .order('id', { ascending: true })
      .limit(PRUNE_BATCH_SIZE);

    if (selectError) {
      captureDatabaseError(selectError, 'prune_select_candidates');
      throw selectError;
    }
    if (!candidates || candidates.length === 0) return;

    const ids = candidates.map((row) => row.id);

    let referenced: Set<string>;
    try {
      referenced = await loadReferencedEventIds(db, userId, ids);
    } catch (error) {
      captureDatabaseError(error, 'prune_load_referenced');
      throw error;
    }
    const prunable = ids.filter((id) => !referenced.has(id));

    if (prunable.length > 0) {
      const { error: deleteError } = await db
        .from(databaseTables.externalCalendarEvents)
        .delete()
        // service_role は RLS を bypass するので user_id / connection_id を明示的に添える
        // （defense-in-depth。id は既に scope 済みの select 結果なので機能的には冗長）。
        .eq('user_id', userId)
        .eq('connection_id', connectionId)
        .in('id', prunable);

      if (deleteError) {
        if (deleteError.code === '23503') {
          // select と delete の間に plan が作られると 23503。次回に回収されるので警告に留める。
          logger.warn('[calendar-prune] skipped some rows due to a reference race');
        } else {
          // 23503 以外（権限・timeout 等）は既知のレースではない。ここで飲み込むと disconnect
          // の fail-closed が効かず、連鎖する未参照行を永久に見失う（#1988）。throw する。
          captureDatabaseError(deleteError, 'prune_delete_candidates');
          throw deleteError;
        }
      }
    }

    cursor = ids[ids.length - 1] ?? cursor;
    if (candidates.length < PRUNE_BATCH_SIZE) return;
  }

  // window / calendars scope でこの上限に当たるのは、prune 条件かページングが壊れている
  // 時だけ。connection scope は上限をずっと高く取っているので、正規の接続がここに来る
  // ことは実質無い（真のページングバグの backstop）。掃除が途中で止まった事実は、次の run
  // が黙って同じ所で止まるので log だけでは見えない。
  logger.warn('[calendar-prune] stopped at the batch limit', { batches: batchLimit });
  // 上限値は logger 側にだけ出す。`CaptureErrorContext` は string キーしか持たず、
  // 数値を足しても型で弾かれ、通っても sanitize の allowlist で捨てられる。
  const batchLimitError = new Error('calendar event pruning hit the batch limit');
  captureUnexpectedError(batchLimitError, {
    feature: 'external_calendar',
    operation: 'prune_batch_limit',
  });
  // ここで return すると disconnect の fail-closed が効かず、上限を超えた残り行が
  // connection 削除で永久に回収不能になる（#1988 と同じ形の穴）。throw して呼び出し元に選ばせる。
  throw batchLimitError;
}

function captureDatabaseError(error: unknown, operation: string): void {
  captureUnexpectedDatabaseError(error, { feature: 'external_calendar', operation });
}
