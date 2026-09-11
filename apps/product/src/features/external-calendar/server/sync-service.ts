import { getBillingAccess } from '@/lib/billing/access-service';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import 'server-only';

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import { databaseTables, type Database, type Json } from '@/lib/database';
import {
  getConfiguredExternalLifecycleAppVersion,
  isConfiguredFencedCalendarSyncWriterReady,
} from '@/lib/database/external-lifecycle-version';
import { EXTERNAL_CALENDAR_WINDOW_RADIUS_MS } from '@/lib/external-calendar-ghost';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';

import { deleteUnreferencedEvents } from './event-pruning';
import { ExternalCalendarServiceError } from './external-calendar-service-error';
import {
  beginCalendarSyncRun,
  clearCalendarSyncCursor,
  finishCalendarSyncRun,
  persistCalendarSyncResult,
  resolveProjectKey,
  type CasContext,
} from './fenced-sync-writer';
import { googleCalendarAdapter } from './providers/google';
import {
  CalendarProviderError,
  type CalendarProviderAdapter,
  type NormalizedExternalEvent,
  type ProviderSession,
  type SyncWindow,
} from './providers/types';
import { decryptToken } from './token-crypto';
import { markCalendarConnectionReauth, persistCalendarTokenRotation } from './token-rotation';

/**
 * 外部カレンダー同期エンジン（overview.md §6-2）。
 *
 * cron route（Step 5）と tRPC `syncNow`（Step 4）が同じ `syncConnection` を呼ぶ。書き込みは
 * すべて service_role で行い、全クエリに `user_id` を明示する（ミラーは authenticated から
 * INSERT/DELETE できない）。
 */

/** iCal feed route / token endpoint と同じ外部呼び出しタイムアウト（`lib/supabase/oauth.ts`）。 */
const DB_REQUEST_TIMEOUT_MS = 15_000;

/** tombstone UPDATE の 1 バッチあたり件数。URL 長を意識した値。 */
const TOMBSTONE_BATCH_SIZE = 150;

/**
 * ページングループ後に確定的に走る永続化（upsert 1 回・tombstone バッチ・token 保存）の
 * ための予算取り置き（#1965）。adapter へ渡す deadline はこれを引いた値にする — 素の
 * `deadlineAt` をそのまま渡すと、判定直後に次ページを取りに行かない分岐はあっても、
 * 直前に取得済みのページの永続化そのものが予算を考慮しないため、大きい応答（cancelled
 * 集中等）で maxDuration の hard kill に間に合わない run が起きうる
 * （risk-reviewer 指摘、PR #2075）。
 *
 * `2 * DB_REQUEST_TIMEOUT_MS` は「upsert 1 回 + もう 1 回の書き込み（token 保存 or
 * tombstone 1 バッチ）」の典型ケースを覆う値。tombstone が 1 バッチを超える極端な
 * cancelled 集中（1 ページに `TOMBSTONE_BATCH_SIZE` を大きく超える cancelled が返る場合）
 * は、他の worst-case-of-everything 同様に受容する残余リスクとする
 * （`route-duration-contract.test.ts` の位置づけと同じ — 予算は blast radius の上限で
 * あって全依存同時ハング時の完走保証ではない）。
 */
export const PERSIST_RESERVE_MS = 2 * DB_REQUEST_TIMEOUT_MS;

const PROVIDER = 'google';

/**
 * `last_sync_error` に入れる安定コード。
 *
 * この列は authenticated に SELECT が GRANT されているので、provider の生メッセージや URL を
 * 入れてはいけない（PII / 内部情報の露出）。値域を閉じておき、UI（Step 6）が i18n する。
 *
 * **DB 側 allowlist との二重管理に注意**（risk-reviewer 指摘、PR #2075。#2078 で解消済み）。
 * fenced sync writer v1（`supabase/migrations/20260730090017_fenced_calendar_sync_writers.sql`
 * の `finish_calendar_sync_run_v1`）の `p_last_sync_error` allowlist は
 * `20260820120000_extend_calendar_sync_error_allowlist.sql`（#2078）でこの型と同じ 6 値に
 * 拡張済み。以後この型に新値を足す時は allowlist migration を同じ PR に含める。
 */
type SyncErrorCode =
  | 'reauth_required'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'encryption_key_invalid'
  | 'partial_failure'
  /** wall-clock 予算切れで一部カレンダーへ着手できなかった（#1965）。`partial_failure`
   * （provider / DB が実際に失敗した）とは区別する — こちらは次回 sync で前進する見込みがある。 */
  | 'partial_timeout';

// Step 4（tRPC）/ Step 5（cron）が消費者になるまで export しない。呼び出し側は
// Awaited<ReturnType<typeof syncConnection>> で受け、必要になった時点で export する。
type SyncOutcome =
  | 'synced'
  | 'skipped_reauth_required'
  | 'reauth_required'
  | 'encryption_key_invalid'
  | 'partial_failure'
  | 'partial_timeout'
  | 'not_configured';

type SyncConnectionResult = {
  outcome: SyncOutcome;
  calendarsSynced: number;
  calendarsFailed: number;
};

/**
 * service_role client が触れる surface を同期に必要な 3 テーブルへ narrow する。
 * `connection-service.ts` と同じ理由 — RLS を bypass する client が他テーブルへ到達できると
 * cross-tenant leak になるので compile error で止める。plans / records の anti-join は
 * `event-pruning.ts` が別 client で担うので、ここには含めない。
 */
type SyncDatabase = {
  public: {
    Tables: Pick<
      Database['public']['Tables'],
      'external_calendar_events' | 'calendar_connections' | 'calendar_connection_calendars'
    >;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type SyncClient = SupabaseClient<SyncDatabase>;

function createSyncDbClient(): SyncClient {
  return createClient<SyncDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    // narrow 版には `createServiceRoleClient` の timeout 注入が無いので、ここで足す。
    global: {
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
        }),
    },
  });
}

/** `refresh_token_enc` は column-scoped grant 外だが service_role なので読める。列は明示列挙する。 */
type ConnectionRow = {
  data_generation: number;
  id: string;
  user_id: string;
  status: string;
  refresh_token_enc: string;
};

type CalendarRow = {
  /** fenced RPC 群（`>= 2` 分岐）の `p_calendar_selection_id` に使う。legacy 分岐では未使用。 */
  id: string;
  provider_calendar_id: string;
  calendar_name: string | null;
  sync_token: string | null;
};

/** `syncConnectionFenced` が `begin_calendar_sync_run_v1` の結果から組み立てる CAS state。 */
type FencedRunState = {
  connectionId: string;
  userId: string;
  projectKey: string;
  expectedGeneration: number;
  expectedAuthorityFenceId: string;
  expectedAuthorityEpoch: number;
  expectedSyncSequence: number;
  runStartedAtIso: string;
  refreshTokenEnc: string;
};

function toCasContext(state: FencedRunState): CasContext {
  return {
    connectionId: state.connectionId,
    userId: state.userId,
    projectKey: state.projectKey,
    expectedGeneration: state.expectedGeneration,
    expectedAuthorityFenceId: state.expectedAuthorityFenceId,
    expectedAuthorityEpoch: state.expectedAuthorityEpoch,
  };
}

/**
 * 1 接続を同期する。
 *
 * provider / 個別カレンダーの失敗ではここで throw しない（既に `last_sync_error` と Sentry に
 * 記録済み）。cron が 1 接続の失敗で全体を止めないための設計。ただし connection 行すら読めない
 * DB 障害だけは、状態を記録する術も無い真の異常なので `ExternalCalendarServiceError` を投げて
 * 呼び出し側（cron dispatcher / tRPC）に委ねる。connection が単に存在しない場合は
 * `outcome: 'not_configured'` を返す。
 */
export async function syncConnection(params: {
  connectionId: string;
  userId: string;
  /** true なら全カレンダーの sync_token を無視して full sync する（overview.md §6-2 の定期 full resync 機構）。 */
  forceFullSync?: boolean;
  /**
   * `Date.now()` 換算の締切（ms）（#1965）。省略時は無制限（既存呼び出し互換）。
   * カレンダー単位・ページ単位の両方のループで尊重される — 呼び出し側は自分の
   * maxDuration に対する安全マージンを引いた値を渡す（cron の `TIME_BUDGET_MS` と同じ形）。
   */
  deadlineAt?: number | undefined;
}): Promise<SyncConnectionResult> {
  const { connectionId, userId, forceFullSync = false, deadlineAt } = params;
  if (!(await getBillingAccess(createServiceRoleClient(), userId)).canUseProduct) {
    throw new ExternalCalendarServiceError('FORBIDDEN', 'Product access has ended');
  }
  const adapter: CalendarProviderAdapter = googleCalendarAdapter;
  const db = createSyncDbClient();

  // #2050: fenced sync writer RPC 群（20260730090017 + #2078 の allowlist 拡張 +
  // `_v3` terminal marker）が揃っている接続だけ新経路を使う。この判定は
  // `getConfiguredExternalLifecycleAppVersion`（Candidate 3 marker、settings/billing・
  // cron dispatcher 等の無関係な既存呼び出し元と共有）とは別関数に分離してある
  // — widen すると既存呼び出し元の RPC 呼び出し契約が変わり、無関係な test が
  // regression する（overview.md §0 改訂）。揃っていなければ v0/v1 の直接書き込み
  // パスをそのまま使う（無変更）。
  const fencedWriterReady = await isConfiguredFencedCalendarSyncWriterReady();
  if (fencedWriterReady) {
    return syncConnectionFenced({ db, adapter, connectionId, userId, forceFullSync, deadlineAt });
  }

  const lifecycleVersion = await getConfiguredExternalLifecycleAppVersion();

  // run の生成時刻。全 upsert 行と sweep 条件の両方でこの単一値を使う。行ごとに now() を
  // 使うと sweep の境界がぶれて正しい行を消す。
  const runStartedAt = new Date();
  const runStartedAtIso = runStartedAt.toISOString();

  const connection = await loadConnection(db, connectionId, userId, lifecycleVersion);
  if (connection === null) {
    return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
  }

  if (connection.status === 'reauth_required') {
    return { outcome: 'skipped_reauth_required', calendarsSynced: 0, calendarsFailed: 0 };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(
      connection.refresh_token_enc,
      env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
    );
  } catch (error) {
    // 鍵の設定ミスは運用側のバグ。全ユーザーを再同意に追い込まないよう status は変えない。
    captureUnexpectedError(error instanceof Error ? error : new Error('token decrypt failed'), {
      feature: 'external_calendar',
      operation: 'decrypt_refresh_token',
    });
    await writeConnectionError(db, connectionId, userId, 'encryption_key_invalid', runStartedAtIso);
    return { outcome: 'encryption_key_invalid', calendarsSynced: 0, calendarsFailed: 0 };
  }

  // provider callの応答が失われても同じtoken acquisitionをDB側で同定できるよう、
  // operation IDはrefresh開始前に一度だけ生成する。
  const rotationOperationId = randomUUID();
  let session: ProviderSession;
  try {
    session = await adapter.startSession(refreshToken);
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      const reauthOutcome = await markCalendarConnectionReauth({
        userId,
        connectionId,
        expectedGeneration: connection.data_generation,
        expectedRefreshTokenEnc: connection.refresh_token_enc,
        lastSyncedAt: runStartedAtIso,
      });
      return reauthResult(reauthOutcome, 0, 0);
    }
    captureProviderError(error, 'start_session');
    await writeConnectionError(db, connectionId, userId, providerErrorCode(error), runStartedAtIso);
    return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
  }

  // Google が rotation した場合だけ保存し直す。黙って捨てると次回から死ぬ。
  let markReauthAfterRotation: Awaited<
    ReturnType<typeof persistCalendarTokenRotation>
  >['markReauthIfCurrent'] = null;
  if (session.rotatedRefreshToken !== null) {
    const rotationResult = await persistCalendarTokenRotation({
      operationId: rotationOperationId,
      userId,
      connectionId,
      expectedGeneration: connection.data_generation,
      expectedRefreshTokenEnc: connection.refresh_token_enc,
      rotatedRefreshToken: session.rotatedRefreshToken,
      encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
      provider: adapter,
      lastSyncedAt: runStartedAtIso,
    });
    const { outcome: rotationOutcome } = rotationResult;
    markReauthAfterRotation = rotationResult.markReauthIfCurrent;

    if (rotationOutcome === 'enqueued' || rotationOutcome === 'missing') {
      return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
    }

    if (rotationOutcome === 'reauth_required') {
      return { outcome: 'reauth_required', calendarsSynced: 0, calendarsFailed: 0 };
    }
    if (rotationOutcome === 'superseded') {
      return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
    }
    if (rotationOutcome === 'unresolved') {
      throw new ExternalCalendarServiceError(
        'SYNC_FAILED',
        'calendar token rotation is unresolved',
      );
    }
  }

  const calendars = await loadSelectedCalendars(db, connectionId, userId);
  if (calendars === null) {
    // Sentry には既に出ている。ここでは「成功として last_synced_at を進めない」ことと、
    // ユーザーに見える形でエラーを残すことが要る。
    await writeConnectionError(db, connectionId, userId, 'partial_failure', runStartedAtIso);
    return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
  }

  const window: SyncWindow = {
    timeMin: new Date(runStartedAt.getTime() - EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString(),
    timeMax: new Date(runStartedAt.getTime() + EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString(),
  };

  let calendarsSynced = 0;
  let calendarsFailed = 0;
  // 予算切れで着手できなかった／完走できなかったカレンダー数。calendarsFailed とは区別する
  // （こちらは provider / DB が実際に失敗したわけではなく、次回 sync で前進する見込みがある）。
  let calendarsIncomplete = 0;
  let reauthRequired = false;

  for (const calendar of calendars) {
    const outcome = await syncOneCalendar({
      db,
      adapter,
      session,
      connection,
      calendar,
      window,
      runStartedAtIso,
      forceFullSync,
      deadlineAt,
    });

    if (outcome === 'synced') calendarsSynced += 1;
    else if (outcome === 'reauth_required') reauthRequired = true;
    else if (outcome === 'deadline_exceeded') calendarsIncomplete += 1;
    else calendarsFailed += 1;
  }

  if (reauthRequired) {
    // rotation済みなら同じrunが保存した新ciphertextをclosure内のCAS証明でmarkする。
    // 旧ciphertextで判定すると、正しい新authorityをsupersededと誤認する。
    const reauthOutcome =
      markReauthAfterRotation === null
        ? await markCalendarConnectionReauth({
            userId,
            connectionId,
            expectedGeneration: connection.data_generation,
            expectedRefreshTokenEnc: connection.refresh_token_enc,
            lastSyncedAt: runStartedAtIso,
          })
        : await markReauthAfterRotation();
    return reauthResult(reauthOutcome, calendarsSynced, calendarsFailed);
  }

  // 参照されていない window 外行を掃除する。connection 単位で 1 回だけ（calendar ごとに
  // 回すと他カレンダーの行も対象になり、無駄に N 回走る）。window 境界は provider へ渡したのと
  // 同じ値を使う。anti-join の本体は event-pruning.ts に集約している。
  // best-effort — 失敗しても sync 自体は成功として扱う（fail-closed にすると cleanup 失敗が
  // 同期結果全体を巻き込む）。拾いきれなかった行は次回の sync か disconnect の prune が回収する。
  //
  // 予算切れが起きた run ではスキップする。prune は元々 best-effort で必須の後始末ではない
  // ため、ただでさえ足りない残り予算をここに使うより次回の sync に譲る方が安全（risk-reviewer
  // 指摘、PR #2075）。
  if (calendarsIncomplete === 0) {
    try {
      await deleteUnreferencedEvents({
        userId,
        connectionId,
        scope: { kind: 'window', notBefore: window.timeMin, notAfter: window.timeMax },
      });
    } catch (error) {
      logger.warn('[calendar-sync] failed to prune out-of-window events');
      captureUnexpectedError(error instanceof Error ? error : new Error('calendar prune failed'), {
        feature: 'external_calendar',
        operation: 'sync_window_prune',
      });
    }
  }

  // 実際の失敗（provider / DB エラー）を予算切れより先に報告する。両方が同一 run で
  // 起きた場合、後者を先に返すと「選択を確認して」という実失敗側の行動喚起が
  // 「もう一度お試しください」に隠れてしまう（risk-reviewer 指摘、PR #2075）。
  if (calendarsFailed > 0) {
    await writeConnectionError(db, connectionId, userId, 'partial_failure', runStartedAtIso);
    return { outcome: 'partial_failure', calendarsSynced, calendarsFailed };
  }

  if (calendarsIncomplete > 0) {
    // 予算切れで一部カレンダーへ着手できなかった／完走できなかった。
    if (calendarsSynced > 0) {
      // 部分的に進捗があった（sync_token は完走した分だけ既に確定済み）。次回 sync は
      // 残りのカレンダーから再開する。last_synced_at を進めて記録する。
      await writeConnectionError(db, connectionId, userId, 'partial_timeout', runStartedAtIso);
    }
    // else: 完全な空振り（1 カレンダーも完走しなかった）。last_synced_at を進めると
    // due 判定（last_synced_at 昇順）でこの接続が列の最後尾へ回り、starvation 防止の
    // 順序が無効化される。次回 run が最優先で再試行できるよう、何も書き込まない
    // （risk-reviewer 指摘、PR #2075）。
    return { outcome: 'partial_timeout', calendarsSynced, calendarsFailed };
  }

  await writeConnectionSuccess(db, connectionId, userId, runStartedAtIso);
  return { outcome: 'synced', calendarsSynced, calendarsFailed };
}

type CalendarSyncOutcome = 'synced' | 'reauth_required' | 'deadline_exceeded' | 'failed';

async function syncOneCalendar(args: {
  db: SyncClient;
  adapter: CalendarProviderAdapter;
  session: ProviderSession;
  connection: ConnectionRow;
  calendar: CalendarRow;
  window: SyncWindow;
  runStartedAtIso: string;
  forceFullSync: boolean;
  deadlineAt?: number | undefined;
}): Promise<CalendarSyncOutcome> {
  const {
    db,
    adapter,
    session,
    connection,
    calendar,
    window,
    runStartedAtIso,
    forceFullSync,
    deadlineAt,
  } = args;

  const cursor = forceFullSync ? null : calendar.sync_token;

  // adapter には PERSIST_RESERVE_MS を引いた締切を渡す。素の deadlineAt をそのまま渡すと、
  // 判定直後に取得したページの永続化（upsert / tombstone / token 保存）自体が予算を
  // 考慮しないため、maxDuration の hard kill に間に合わない run が起きうる。
  const adapterDeadlineAt = deadlineAt === undefined ? undefined : deadlineAt - PERSIST_RESERVE_MS;

  let result: Awaited<ReturnType<CalendarProviderAdapter['syncCalendar']>>;
  try {
    result = await adapter.syncCalendar(session, {
      calendarId: calendar.provider_calendar_id,
      cursor,
      window,
      deadlineAt: adapterDeadlineAt,
    });

    if (result.cursorInvalid) {
      // 410。cursor を捨てて同じ run 内で 1 回だけ full sync をやり直す。
      await clearSyncToken(db, connection, calendar);
      result = await adapter.syncCalendar(session, {
        calendarId: calendar.provider_calendar_id,
        cursor: null,
        window,
        deadlineAt: adapterDeadlineAt,
      });
    }
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      return 'reauth_required';
    }
    captureProviderError(error, 'sync_calendar');
    return 'failed';
  }

  try {
    if (!(await getBillingAccess(createServiceRoleClient(), connection.user_id)).canUseProduct)
      return 'failed';
    if (result.events.length > 0) {
      await upsertActiveEvents(db, connection, calendar, result.events, runStartedAtIso);
    }

    const tombstoneIds = [...result.cancelledEventIds, ...result.skippedEventIds];
    if (tombstoneIds.length > 0) {
      await tombstoneEvents(db, connection, calendar, tombstoneIds, runStartedAtIso);
    }

    // full sync は cancelled を返さない（showDeleted 既定 false）ので、provider 側で消えた
    // 行が active のまま残る。全ページ完走した full sync のときだけ mark-and-sweep で掃除する。
    // ページ途中で落ちた（nextCursor === null かつ events 未完）run では走らせない。
    if (result.usedFullSync && result.nextCursor !== null) {
      if (!(await getBillingAccess(createServiceRoleClient(), connection.user_id)).canUseProduct)
        return 'failed';
      await sweepStaleEvents(db, connection, calendar, runStartedAtIso);
    }

    // 全ページ走破に成功したときだけ cursor を確定する。途中で落ちたら保存せず、次回また
    // 先頭からやり直す（upsert は冪等）。
    if (result.nextCursor !== null) {
      if (!(await getBillingAccess(createServiceRoleClient(), connection.user_id)).canUseProduct)
        return 'failed';
      await saveSyncToken(db, connection, calendar, result.nextCursor, runStartedAtIso);
    }

    // 予算切れで打ち切られた（events/tombstone は取得できた分だけ保存済み）。'synced' に
    // 含めると、次回 sync が要ることが呼び出し側から見えなくなる。
    if (result.deadlineExceeded) return 'deadline_exceeded';

    return 'synced';
  } catch (error) {
    captureDatabaseError(error, 'persist_calendar_events');
    return 'failed';
  }
}

// =============================================================================
// #2050: fenced sync writer RPC 群を使う経路（`lifecycleVersion >= 2`）
//
// v0/v1 分岐（上記）とは独立した並行実装。5 RPC の CAS ロジック本体（凍結資産）は
// 変更しない — 呼び出し方と結果マッピングだけをここに書く
// （issue #2050 のコメント欄 overview.md §3 相当、docs/projects 全廃に伴い #2473 で移設）。
// =============================================================================

/** 1 chunk あたりの最大 event 数。RPC 側の 10,000 件上限に対して十分な余裕を取る。 */
const PERSIST_EVENT_CHUNK_SIZE = 2_000;

async function syncConnectionFenced(args: {
  db: SyncClient;
  adapter: CalendarProviderAdapter;
  connectionId: string;
  userId: string;
  forceFullSync: boolean;
  deadlineAt?: number | undefined;
}): Promise<SyncConnectionResult> {
  const { db, adapter, connectionId, userId, forceFullSync, deadlineAt } = args;

  const projectKey = resolveProjectKey();
  if (projectKey === null) {
    return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
  }

  const begin = await beginCalendarSyncRun({ connectionId, userId, projectKey, deadlineAt });
  if (typeof begin === 'string') {
    // callRpc 内で Sentry capture 済み（unresolved / rejected_input）か、想定内
    // （account_deleting / deadline_exceeded）。いずれも安全な no-op として畳む
    // （pr-cross-review P2 指摘、PR #2276 — 残予算不足時は試行せず即座に諦める）。
    return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
  }
  if (begin.result === 'missing') {
    return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
  }
  if (begin.result === 'reauth_required') {
    return { outcome: 'skipped_reauth_required', calendarsSynced: 0, calendarsFailed: 0 };
  }
  if (begin.result === 'superseded') {
    // project fence / quarantine fence が ready でない場合（全ユーザーに影響しうる
    // グローバル状態）もここに含まれるため、無音の全停止を防ぐため必ず capture する
    // （overview.md §3、critic 指摘）。
    captureUnexpectedError(new Error('calendar sync fence was superseded before it started'), {
      feature: 'external_calendar',
      operation: 'calendar_sync_fence_superseded',
    });
    return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
  }

  const runState: FencedRunState = {
    connectionId,
    userId,
    projectKey,
    expectedGeneration: begin.dataGeneration,
    expectedAuthorityFenceId: begin.authorityFenceId,
    expectedAuthorityEpoch: begin.authorityEpoch,
    expectedSyncSequence: begin.syncSequence,
    runStartedAtIso: begin.runStartedAt,
    refreshTokenEnc: begin.refreshTokenEnc,
  };

  let refreshToken: string;
  try {
    refreshToken = decryptToken(runState.refreshTokenEnc, env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '');
  } catch (error) {
    captureUnexpectedError(error instanceof Error ? error : new Error('token decrypt failed'), {
      feature: 'external_calendar',
      operation: 'decrypt_refresh_token',
    });
    await finishFencedSyncRunBestEffort(runState, 'encryption_key_invalid', deadlineAt);
    return { outcome: 'encryption_key_invalid', calendarsSynced: 0, calendarsFailed: 0 };
  }

  const rotationOperationId = randomUUID();
  let session: ProviderSession;
  try {
    session = await adapter.startSession(refreshToken);
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      const reauthOutcome = await markCalendarConnectionReauth({
        userId,
        connectionId,
        expectedGeneration: runState.expectedGeneration,
        expectedRefreshTokenEnc: runState.refreshTokenEnc,
        lastSyncedAt: runState.runStartedAtIso,
      });
      return reauthResult(reauthOutcome, 0, 0);
    }
    captureProviderError(error, 'start_session');
    await finishFencedSyncRunBestEffort(runState, providerErrorCode(error), deadlineAt);
    return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
  }

  let markReauthAfterRotation: Awaited<
    ReturnType<typeof persistCalendarTokenRotation>
  >['markReauthIfCurrent'] = null;
  if (session.rotatedRefreshToken !== null) {
    const rotationResult = await persistCalendarTokenRotation({
      operationId: rotationOperationId,
      userId,
      connectionId,
      expectedGeneration: runState.expectedGeneration,
      expectedRefreshTokenEnc: runState.refreshTokenEnc,
      rotatedRefreshToken: session.rotatedRefreshToken,
      encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
      provider: adapter,
      lastSyncedAt: runState.runStartedAtIso,
    });
    const { outcome: rotationOutcome } = rotationResult;
    markReauthAfterRotation = rotationResult.markReauthIfCurrent;

    if (rotationOutcome === 'enqueued' || rotationOutcome === 'missing') {
      return { outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 };
    }
    if (rotationOutcome === 'reauth_required') {
      return { outcome: 'reauth_required', calendarsSynced: 0, calendarsFailed: 0 };
    }
    if (rotationOutcome === 'superseded') {
      return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
    }
    if (rotationOutcome === 'unresolved') {
      throw new ExternalCalendarServiceError(
        'SYNC_FAILED',
        'calendar token rotation is unresolved',
      );
    }
  }

  const calendars = await loadSelectedCalendars(db, connectionId, userId);
  if (calendars === null) {
    await finishFencedSyncRunBestEffort(runState, 'partial_failure', deadlineAt);
    return { outcome: 'partial_failure', calendarsSynced: 0, calendarsFailed: 0 };
  }

  const runStartedAt = new Date(runState.runStartedAtIso);
  const window: SyncWindow = {
    timeMin: new Date(runStartedAt.getTime() - EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString(),
    timeMax: new Date(runStartedAt.getTime() + EXTERNAL_CALENDAR_WINDOW_RADIUS_MS).toISOString(),
  };

  let calendarsSynced = 0;
  let calendarsFailed = 0;
  let calendarsIncomplete = 0;
  let reauthRequired = false;
  let runSuperseded = false;

  for (const calendar of calendars) {
    if (runSuperseded) break;

    const outcome = await syncOneCalendarFenced({
      adapter,
      session,
      runState,
      calendar,
      window,
      forceFullSync,
      deadlineAt,
    });

    if (outcome === 'synced') calendarsSynced += 1;
    else if (outcome === 'reauth_required') reauthRequired = true;
    else if (outcome === 'deadline_exceeded') calendarsIncomplete += 1;
    else if (outcome === 'run_superseded') runSuperseded = true;
    else calendarsFailed += 1;
  }

  if (runSuperseded) {
    // 良性競合（先行/後続 run に追い越された）。last_sync_error は書かず、次回
    // スケジュールに委ねる（overview.md §3）。
    return { outcome: 'not_configured', calendarsSynced, calendarsFailed };
  }

  if (reauthRequired) {
    const reauthOutcome =
      markReauthAfterRotation === null
        ? await markCalendarConnectionReauth({
            userId,
            connectionId,
            expectedGeneration: runState.expectedGeneration,
            expectedRefreshTokenEnc: runState.refreshTokenEnc,
            lastSyncedAt: runState.runStartedAtIso,
          })
        : await markReauthAfterRotation();
    return reauthResult(reauthOutcome, calendarsSynced, calendarsFailed);
  }

  if (calendarsIncomplete === 0) {
    try {
      await deleteUnreferencedEvents({
        userId,
        connectionId,
        scope: { kind: 'window', notBefore: window.timeMin, notAfter: window.timeMax },
      });
    } catch (error) {
      logger.warn('[calendar-sync] failed to prune out-of-window events');
      captureUnexpectedError(error instanceof Error ? error : new Error('calendar prune failed'), {
        feature: 'external_calendar',
        operation: 'sync_window_prune',
      });
    }
  }

  if (calendarsFailed > 0) {
    await finishFencedSyncRunBestEffort(runState, 'partial_failure', deadlineAt);
    return { outcome: 'partial_failure', calendarsSynced, calendarsFailed };
  }

  if (calendarsIncomplete > 0) {
    if (calendarsSynced > 0) {
      await finishFencedSyncRunBestEffort(runState, 'partial_timeout', deadlineAt);
    }
    return { outcome: 'partial_timeout', calendarsSynced, calendarsFailed };
  }

  await finishFencedSyncRunBestEffort(runState, null, deadlineAt);
  return { outcome: 'synced', calendarsSynced, calendarsFailed };
}

async function syncOneCalendarFenced(args: {
  adapter: CalendarProviderAdapter;
  session: ProviderSession;
  runState: FencedRunState;
  calendar: CalendarRow;
  window: SyncWindow;
  forceFullSync: boolean;
  deadlineAt?: number | undefined;
}): Promise<CalendarSyncOutcome | 'run_superseded'> {
  const { adapter, session, runState, calendar, window, forceFullSync, deadlineAt } = args;
  const cas = toCasContext(runState);

  const cursor = forceFullSync ? null : calendar.sync_token;
  const adapterDeadlineAt = deadlineAt === undefined ? undefined : deadlineAt - PERSIST_RESERVE_MS;

  let result: Awaited<ReturnType<CalendarProviderAdapter['syncCalendar']>>;
  try {
    result = await adapter.syncCalendar(session, {
      calendarId: calendar.provider_calendar_id,
      cursor,
      window,
      deadlineAt: adapterDeadlineAt,
    });

    if (result.cursorInvalid) {
      const clearOutcome = await clearCalendarSyncCursor({
        ...cas,
        expectedSyncSequence: runState.expectedSyncSequence,
        calendarSelectionId: calendar.id,
        providerCalendarId: calendar.provider_calendar_id,
        expectedSyncToken: calendar.sync_token,
        deadlineAt,
      });
      // 残予算不足で試行しなかった（pr-cross-review P2 指摘、PR #2276）。'failed' にせず
      // 既存の deadlineExceeded 経路と同じ扱いにする。
      if (clearOutcome === 'deadline_exceeded') return 'deadline_exceeded';
      // 'superseded' は応答喪失後の retry で「既に clear 済み」を意味しうる
      // （overview.md §3）。'failed' にせず full sync として続行する。
      if (clearOutcome === 'missing_selection' || clearOutcome === 'missing') {
        captureDatabaseError(
          new Error('calendar selection missing during cursor clear'),
          'clear_sync_cursor',
        );
        return 'failed';
      }
      if (
        typeof clearOutcome === 'string' &&
        clearOutcome !== 'cleared' &&
        clearOutcome !== 'superseded'
      ) {
        return 'failed';
      }

      result = await adapter.syncCalendar(session, {
        calendarId: calendar.provider_calendar_id,
        cursor: null,
        window,
        deadlineAt: adapterDeadlineAt,
      });
    }
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      return 'reauth_required';
    }
    captureProviderError(error, 'sync_calendar');
    return 'failed';
  }

  try {
    const persistOutcome = await persistCalendarSyncResultChunked({
      cas,
      runState,
      calendar,
      result,
      deadlineAt,
    });
    if (persistOutcome === 'run_superseded') return 'run_superseded';
    if (persistOutcome === 'deadline_exceeded') return 'deadline_exceeded';
    if (persistOutcome === 'failed') return 'failed';

    if (result.deadlineExceeded) return 'deadline_exceeded';
    return 'synced';
  } catch (error) {
    captureDatabaseError(error, 'persist_calendar_events');
    return 'failed';
  }
}

/**
 * `persist_calendar_sync_result_command_v1` の 10,000 件上限・events/tombstone 間の id
 * 重複拒否（migration:401-404, 460-464）に対応する chunk 化 + dedupe（overview.md §3）。
 *
 * 最終 chunk だけが tombstone / usedFullSync / nextCursor を運ぶ。events が 0 件でも
 * tombstone か nextCursor があれば 1 回は呼ぶ。全て空なら呼ばない（元の 4 分岐と同じ意味論）。
 */
async function persistCalendarSyncResultChunked(args: {
  cas: CasContext;
  runState: FencedRunState;
  calendar: CalendarRow;
  result: Awaited<ReturnType<CalendarProviderAdapter['syncCalendar']>>;
  deadlineAt?: number | undefined;
}): Promise<'persisted' | 'run_superseded' | 'deadline_exceeded' | 'failed'> {
  const { cas, runState, calendar, result, deadlineAt } = args;

  const dedupedEventsByProviderId = new Map<string, NormalizedExternalEvent>();
  for (const event of result.events) {
    // 後勝ち（provider が同一 id を複数ページで返した場合、最後の値を採用する）。
    dedupedEventsByProviderId.set(event.providerEventId, event);
  }
  const dedupedEvents = [...dedupedEventsByProviderId.values()];

  const tombstoneIdSet = new Set(
    [...result.cancelledEventIds, ...result.skippedEventIds].filter(
      (id) => !dedupedEventsByProviderId.has(id),
    ),
  );
  const tombstoneIds = [...tombstoneIdSet];

  const needsWrite =
    dedupedEvents.length > 0 || tombstoneIds.length > 0 || result.nextCursor !== null;
  if (!needsWrite) return 'persisted';

  const eventChunks: NormalizedExternalEvent[][] = [];
  for (let i = 0; i < dedupedEvents.length; i += PERSIST_EVENT_CHUNK_SIZE) {
    eventChunks.push(dedupedEvents.slice(i, i + PERSIST_EVENT_CHUNK_SIZE));
  }
  const chunksToSend = eventChunks.length > 0 ? eventChunks : [[]];

  for (let i = 0; i < chunksToSend.length; i += 1) {
    if (!(await getBillingAccess(createServiceRoleClient(), cas.userId)).canUseProduct)
      return 'failed';
    const isLast = i === chunksToSend.length - 1;
    const outcome = await persistCalendarSyncResult({
      ...cas,
      expectedSyncSequence: runState.expectedSyncSequence,
      calendarSelectionId: calendar.id,
      providerCalendarId: calendar.provider_calendar_id,
      runStartedAt: runState.runStartedAtIso,
      events: chunksToSend[i] as unknown as Json,
      tombstoneEventIds: isLast ? tombstoneIds : [],
      usedFullSync: isLast ? result.usedFullSync : false,
      nextCursor: isLast ? result.nextCursor : null,
      deadlineAt,
    });

    if (outcome === 'persisted') continue;
    if (outcome === 'deadline_exceeded') return 'deadline_exceeded';
    if (outcome === 'superseded' || outcome === 'account_deleting') return 'run_superseded';
    return 'failed';
  }

  return 'persisted';
}

async function finishFencedSyncRunBestEffort(
  runState: FencedRunState,
  lastSyncError: SyncErrorCode | null,
  deadlineAt?: number | undefined,
): Promise<void> {
  // best-effort。既存の updateConnection と同じ意味論 — 失敗しても呼び出し側の
  // outcome は変えない（overview.md §3）。callTextRpc が unresolved/rejected_input を
  // 既に capture 済みなので、ここでは戻り値を見ずに投げっぱなしにする。deadlineAt を
  // 渡すのは残予算が無い時に無駄な retry で予算を食い潰さないため
  // （pr-cross-review P2 指摘、PR #2276）。
  await finishCalendarSyncRun({
    ...toCasContext(runState),
    expectedSyncSequence: runState.expectedSyncSequence,
    runStartedAt: runState.runStartedAtIso,
    lastSyncError,
    deadlineAt,
  });
}

// =============================================================================
// DB 操作
// =============================================================================

async function loadConnection(
  db: SyncClient,
  connectionId: string,
  userId: string,
  lifecycleVersion: 0 | 1,
): Promise<ConnectionRow | null> {
  if (lifecycleVersion === 0) {
    const { data, error } = await db
      .from(databaseTables.calendarConnections)
      .select('id, user_id, status, refresh_token_enc')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      const normalized = captureUnexpectedDatabaseError(error, {
        feature: 'external_calendar',
        operation: 'load_connection',
      });
      throw new ExternalCalendarServiceError('SYNC_FAILED', 'failed to load calendar connection', {
        cause: normalized,
      });
    }
    return data === null ? null : { ...data, data_generation: 0 };
  }

  // 列は明示列挙する。column-scoped grant のため select('*') は 42501 になる。
  const { data, error } = await db
    .from(databaseTables.calendarConnections)
    .select('id, user_id, status, refresh_token_enc, data_generation')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    // connection を読めない = 状態を記録する術も無い。ここだけは throw して呼び出し側へ委ねる。
    const normalized = captureUnexpectedDatabaseError(error, {
      feature: 'external_calendar',
      operation: 'load_connection',
    });
    throw new ExternalCalendarServiceError('SYNC_FAILED', 'failed to load calendar connection', {
      cause: normalized,
    });
  }
  return data;
}

/**
 * 選択済みカレンダーを読む。読めなければ `null`（空の選択と区別する）。
 *
 * 失敗を空配列に畳むと、呼び出し側が「0 件を同期して成功」と解釈して
 * `last_synced_at` を進めてしまう。ユーザーからは「同期済みなのに何も入っていない」に
 * しか見えず、しかも次の run も同じ結果になるので永久に気づけない。
 */
async function loadSelectedCalendars(
  db: SyncClient,
  connectionId: string,
  userId: string,
): Promise<CalendarRow[] | null> {
  const { data, error } = await db
    .from(databaseTables.calendarConnectionCalendars)
    .select('id, provider_calendar_id, calendar_name, sync_token')
    .eq('connection_id', connectionId)
    .eq('user_id', userId);

  if (error) {
    captureDatabaseError(error, 'load_selected_calendars');
    return null;
  }
  return data ?? [];
}

async function upsertActiveEvents(
  db: SyncClient,
  connection: ConnectionRow,
  calendar: CalendarRow,
  events: NormalizedExternalEvent[],
  runStartedAtIso: string,
): Promise<void> {
  // 全行のキー集合を厳密に揃える。PostgREST は配列 upsert のとき全行のキーの和集合を
  // columns に送り、欠けた行は DEFAULT ではなく NULL で埋める。dismissed_at はキーに
  // 含めない（§6-2-5。ON CONFLICT DO UPDATE SET の対象列は INSERT の列と同一なので、
  // 含めなければ既存の dismissed_at が保持される）。
  const rows = events.map((event) => ({
    user_id: connection.user_id,
    provider: PROVIDER,
    connection_id: connection.id,
    provider_calendar_id: calendar.provider_calendar_id,
    provider_event_id: event.providerEventId,
    title: event.title,
    description: event.description,
    calendar_name: calendar.calendar_name,
    start_at: event.startAt,
    end_at: event.endAt,
    status: 'confirmed',
    last_synced_at: runStartedAtIso,
  }));

  const { error } = await db.from(databaseTables.externalCalendarEvents).upsert(rows, {
    onConflict: 'user_id,provider,connection_id,provider_calendar_id,provider_event_id',
  });

  if (error) throw error;
}

async function tombstoneEvents(
  db: SyncClient,
  connection: ConnectionRow,
  calendar: CalendarRow,
  providerEventIds: string[],
  runStartedAtIso: string,
): Promise<void> {
  // UPDATE であって upsert ではない。ミラーに無い id には行を作らない（未知の cancelled 通知が
  // sparse row を無限に増やすのを防ぐ）。既存の start_at / end_at / dismissed_at は残るので、
  // NULL 時刻の不滅ゴミ行が生まれず prune が効く。
  for (let i = 0; i < providerEventIds.length; i += TOMBSTONE_BATCH_SIZE) {
    if (!(await getBillingAccess(createServiceRoleClient(), connection.user_id)).canUseProduct)
      throw new ExternalCalendarServiceError('FORBIDDEN', 'Product access has ended');
    const chunk = providerEventIds.slice(i, i + TOMBSTONE_BATCH_SIZE);
    const { error } = await db
      .from(databaseTables.externalCalendarEvents)
      .update({ status: 'cancelled', last_synced_at: runStartedAtIso })
      .eq('user_id', connection.user_id)
      .eq('connection_id', connection.id)
      .eq('provider_calendar_id', calendar.provider_calendar_id)
      .in('provider_event_id', chunk);

    if (error) throw error;
  }
}

async function sweepStaleEvents(
  db: SyncClient,
  connection: ConnectionRow,
  calendar: CalendarRow,
  runStartedAtIso: string,
): Promise<void> {
  // full sync が触れなかった（= provider から返らなかった = 削除された）行を cancelled 化する。
  // strict 比較 last_synced_at < runStartedAt が並行 run 安全性の要（新しい run が書いた
  // 行は消さない）。DELETE ではなく UPDATE なのは、参照済み行を消せず dismissed も残すため。
  const { error } = await db
    .from(databaseTables.externalCalendarEvents)
    .update({ status: 'cancelled', last_synced_at: runStartedAtIso })
    .eq('user_id', connection.user_id)
    .eq('connection_id', connection.id)
    .eq('provider_calendar_id', calendar.provider_calendar_id)
    .lt('last_synced_at', runStartedAtIso)
    .neq('status', 'cancelled');

  if (error) throw error;
}

async function saveSyncToken(
  db: SyncClient,
  connection: ConnectionRow,
  calendar: CalendarRow,
  syncToken: string,
  runStartedAtIso: string,
): Promise<void> {
  const { error } = await db
    .from(databaseTables.calendarConnectionCalendars)
    .update({ sync_token: syncToken, last_synced_at: runStartedAtIso })
    .eq('user_id', connection.user_id)
    .eq('connection_id', connection.id)
    .eq('provider_calendar_id', calendar.provider_calendar_id);

  if (error) throw error;
}

async function clearSyncToken(
  db: SyncClient,
  connection: ConnectionRow,
  calendar: CalendarRow,
): Promise<void> {
  const { error } = await db
    .from(databaseTables.calendarConnectionCalendars)
    .update({ sync_token: null })
    .eq('user_id', connection.user_id)
    .eq('connection_id', connection.id)
    .eq('provider_calendar_id', calendar.provider_calendar_id);

  if (error) throw error;
}

// =============================================================================
// connection 状態の更新
// =============================================================================

function reauthResult(
  outcome: Awaited<ReturnType<typeof markCalendarConnectionReauth>>,
  calendarsSynced: number,
  calendarsFailed: number,
): SyncConnectionResult {
  if (outcome === 'marked') {
    return { outcome: 'reauth_required', calendarsSynced, calendarsFailed };
  }
  if (outcome === 'missing') {
    return { outcome: 'not_configured', calendarsSynced, calendarsFailed };
  }
  if (outcome === 'superseded') {
    return { outcome: 'partial_failure', calendarsSynced, calendarsFailed };
  }
  throw new ExternalCalendarServiceError(
    'SYNC_FAILED',
    'calendar connection reauthorization is unresolved',
  );
}

async function writeConnectionError(
  db: SyncClient,
  connectionId: string,
  userId: string,
  code: SyncErrorCode,
  runStartedAtIso: string,
): Promise<void> {
  await updateConnection(db, connectionId, userId, {
    last_sync_error: code,
    last_synced_at: runStartedAtIso,
  });
}

async function writeConnectionSuccess(
  db: SyncClient,
  connectionId: string,
  userId: string,
  runStartedAtIso: string,
): Promise<void> {
  await updateConnection(db, connectionId, userId, {
    last_sync_error: null,
    last_synced_at: runStartedAtIso,
  });
}

async function updateConnection(
  db: SyncClient,
  connectionId: string,
  userId: string,
  patch: Partial<Database['public']['Tables']['calendar_connections']['Update']>,
): Promise<void> {
  const { error } = await db
    .from(databaseTables.calendarConnections)
    .update(patch)
    .eq('id', connectionId)
    .eq('user_id', userId);

  if (error) captureDatabaseError(error, 'update_connection');
}

// =============================================================================
// エラー整理
// =============================================================================

/** provider の生メッセージを外へ出さないよう、error → 安定コードに畳む。 */
function providerErrorCode(error: unknown): SyncErrorCode {
  if (error instanceof CalendarProviderError) {
    if (error.kind === 'reauth_required') return 'reauth_required';
    if (error.kind === 'rate_limited') return 'rate_limited';
  }
  return 'provider_unavailable';
}

function captureProviderError(error: unknown, operation: string): void {
  // rate_limited / cursor_invalid は想定内なので Sentry に送らない（quota を焼く増幅経路）。
  if (
    error instanceof CalendarProviderError &&
    (error.kind === 'rate_limited' || error.kind === 'cursor_invalid')
  ) {
    logger.warn('[calendar-sync] provider returned an expected error', { operation });
    return;
  }

  captureUnexpectedError(error instanceof Error ? error : new Error('provider error'), {
    feature: 'external_calendar',
    operation,
    source: 'google_calendar_api',
    // errorCode は allowlist で snake_case ASCII 相当を要求する。kind は既にその形。
    ...(error instanceof CalendarProviderError ? { errorCode: error.kind } : {}),
  });
}

function captureDatabaseError(error: unknown, operation: string): void {
  captureUnexpectedDatabaseError(error, {
    feature: 'external_calendar',
    operation,
  });
}
