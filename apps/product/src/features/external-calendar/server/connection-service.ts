import 'server-only';

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database, Json } from '@/lib/database';
import { databaseTables } from '@/lib/database';
import {
  getConfiguredExternalLifecycleAppVersion,
  isConfiguredFencedCalendarSyncWriterReady,
} from '@/lib/database/external-lifecycle-version';
import { logger } from '@/lib/logger';
import { captureUnexpectedError } from '@/lib/sentry';

import { deleteUnreferencedEvents } from './event-pruning';
import { ExternalCalendarServiceError } from './external-calendar-service-error';
import { replaceSelectedCalendars, resolveProjectKey } from './fenced-sync-writer';
import { TOKEN_REQUEST_TIMEOUT_MS } from './google-oauth';
import { googleCalendarAdapter } from './providers/google';
import { CalendarProviderError } from './providers/types';
import { decryptToken, encryptToken } from './token-crypto';
import { markCalendarConnectionReauth, persistCalendarTokenRotation } from './token-rotation';

/**
 * `calendar_connections` への書き込み。
 *
 * authenticated は column-scoped SELECT しか持たない（`refresh_token_enc` /
 * `granted_scopes` / `provider_account_id` は grant 外）ので、mutation は必ず
 * service_role で行い、`user_id` を明示的に指定する。設計は overview.md §4-4。
 */

/**
 * service-role client が触れる surface を connection 系だけに narrow する。
 * `lib/oauth-server/db.ts` と同じ理由 — RLS を bypass する client が他テーブルへ
 * 到達できると cross-tenant leak になるので、compile error で止める。
 */
type CalendarConnectionDatabase = {
  public: {
    Tables: Pick<
      Database['public']['Tables'],
      'calendar_connections' | 'calendar_connection_calendars'
    >;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type CalendarConnectionClient = SupabaseClient<CalendarConnectionDatabase>;

/**
 * 外部呼び出しの上限。他の service-role client と同値。
 *
 * OAuth callback は一度きりの Google authorization code を消費してから接続を保存する。
 * 上限が無いと route の `maxDuration` が先に発火し、保存結果を返す前に kill された
 * 再試行が使用済み code の `invalid_grant` になって、ユーザーは認可からやり直しになる。
 *
 * export するのは、callback route（#1990）が「code 消費後の DB 書き込みに要する
 * worst case」を導出するのに使うため。手書きの数値を二重管理しない。
 */
export const CALENDAR_CONNECTION_DB_TIMEOUT_MS = 15_000;

function createCalendarConnectionDbClient(): CalendarConnectionClient {
  return createClient<CalendarConnectionDatabase>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (url, options) => {
          return fetch(url, {
            ...options,
            signal: options?.signal ?? AbortSignal.timeout(CALENDAR_CONNECTION_DB_TIMEOUT_MS),
          });
        },
      },
    },
  );
}

const GOOGLE_PROVIDER = 'google';

type SaveConnectionInput = {
  userId: string;
  /** Google の `sub`。email は可変・再利用可なので同定には使わない。 */
  providerAccountId: string;
  providerAccountEmail: string | null;
  grantedScopes: string[];
  refreshToken: string;
  encryptionKey: string;
};

type ReconnectTarget = {
  id: string;
  providerAccountId: string;
  /** 同意画面の `login_hint` に載せる表示用アドレス。判定には使わない（判定は `sub`）。 */
  providerAccountEmail: string | null;
};

type ReconnectExistingConnectionInput = SaveConnectionInput & {
  connectionId: string;
};

/**
 * 接続を保存する。
 *
 * `refresh_token` が返らなかった場合はこの関数を呼ばない。既存行を残したまま
 * `status='active'` に戻すと、失効済みの token を抱えた接続が UI 上「接続済み」に見え、
 * 再認証導線が二度と出なくなる（overview.md §5-4 の reauth_required 遷移が死ぬ）。
 */
export async function saveConnection(input: SaveConnectionInput): Promise<void> {
  const db = createCalendarConnectionDbClient();

  const { error } = await db.from(databaseTables.calendarConnections).upsert(
    {
      user_id: input.userId,
      provider: GOOGLE_PROVIDER,
      provider_account_id: input.providerAccountId,
      provider_account_email: input.providerAccountEmail,
      granted_scopes: input.grantedScopes,
      refresh_token_enc: encryptToken(input.refreshToken, input.encryptionKey),
      status: 'active',
      last_sync_error: null,
    },
    { onConflict: 'user_id,provider,provider_account_id' },
  );

  if (error) {
    // error にトークンは含まれないが、message をそのまま外へ出さない。
    throw new Error(`failed to save calendar connection: ${error.code ?? 'unknown'}`);
  }
}

/**
 * 再接続対象を本人・provider・状態まで限定して読む。
 *
 * `provider_account_id` は Google の安定識別子であり、callback で検証済み `sub` と比較する
 * ためだけに server 内で扱う。UI や cookie には載せない。
 */
export async function getReconnectTarget(
  userId: string,
  connectionId: string,
): Promise<ReconnectTarget | null> {
  const db = createCalendarConnectionDbClient();
  const { data, error } = await db
    .from(databaseTables.calendarConnections)
    .select('id, provider_account_id, provider_account_email')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .eq('provider', GOOGLE_PROVIDER)
    .eq('status', 'reauth_required')
    .maybeSingle();

  if (error) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load reconnect target', {
      cause: error,
    });
  }
  if (!data) return null;
  return {
    id: data.id,
    providerAccountId: data.provider_account_id,
    providerAccountEmail: data.provider_account_email,
  };
}

/**
 * 既存の再接続対象だけを更新する。
 *
 * generic upsert を使うと、callback と切断が競合した際に削除済み接続を再作成できてしまう。
 * そのため id / owner / provider / Google sub / reauth 状態を一つの UPDATE で guard し、
 * 更新行が無ければ再接続失敗として扱う。これにより切断が常に最終的に勝つ。
 */
export async function reconnectExistingConnection(
  input: ReconnectExistingConnectionInput,
): Promise<'updated' | 'missing'> {
  const db = createCalendarConnectionDbClient();
  const { data, error } = await db
    .from(databaseTables.calendarConnections)
    .update({
      provider_account_email: input.providerAccountEmail,
      granted_scopes: input.grantedScopes,
      refresh_token_enc: encryptToken(input.refreshToken, input.encryptionKey),
      status: 'active',
      last_sync_error: null,
    })
    .eq('id', input.connectionId)
    .eq('user_id', input.userId)
    .eq('provider', GOOGLE_PROVIDER)
    .eq('provider_account_id', input.providerAccountId)
    .eq('status', 'reauth_required')
    .select('id')
    .maybeSingle();

  if (error) {
    throw new ExternalCalendarServiceError('UPDATE_FAILED', 'failed to reconnect calendar', {
      cause: error,
    });
  }
  return data ? 'updated' : 'missing';
}

// =============================================================================
// 読み取り（authenticated client 経由。RLS スコープ + 列明示）
// =============================================================================

/** authenticated client から見える connection の列（token 系は grant 外なので含めない）。 */
const CONNECTION_PUBLIC_COLUMNS =
  'id, provider, provider_account_email, status, last_synced_at, last_sync_error, created_at, updated_at' as const;

type CalendarConnectionSummary = {
  id: string;
  provider: string;
  provider_account_email: string | null;
  status: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

type CalendarSyncStatus = {
  connection: CalendarConnectionSummary;
  calendars: Array<{
    provider_calendar_id: string;
    calendar_name: string | null;
    last_synced_at: string | null;
  }>;
};

/**
 * 接続一覧。解約後も自分の接続状態は見えるべきなので protectedProcedure から呼ぶ。
 *
 * authenticated client（RLS スコープ済み）を受け取り、`select('*')` を使わず列明示する
 * （column-scoped grant のため未 grant 列を触ると 42501）。
 */
export async function listConnections(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<CalendarConnectionSummary[]> {
  const { data, error } = await supabase
    .from(databaseTables.calendarConnections)
    .select(CONNECTION_PUBLIC_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to list calendar connections', {
      cause: error,
    });
  }
  return data ?? [];
}

/** 接続 + 選択カレンダーの同期状況。 */
export async function getSyncStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  connectionId: string,
): Promise<CalendarSyncStatus> {
  const { data: connection, error: connectionError } = await supabase
    .from(databaseTables.calendarConnections)
    .select(CONNECTION_PUBLIC_COLUMNS)
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (connectionError) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load connection', {
      cause: connectionError,
    });
  }
  if (!connection) {
    throw new ExternalCalendarServiceError('CONNECTION_NOT_FOUND', 'calendar connection not found');
  }

  const { data: calendars, error: calendarsError } = await supabase
    .from(databaseTables.calendarConnectionCalendars)
    .select('provider_calendar_id, calendar_name, last_synced_at')
    .eq('connection_id', connectionId)
    .eq('user_id', userId)
    .order('provider_calendar_id', { ascending: true });

  if (calendarsError) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load selected calendars', {
      cause: calendarsError,
    });
  }

  return { connection, calendars: calendars ?? [] };
}

// =============================================================================
// mutation / provider 呼び出し（service_role client）
// =============================================================================

type SelectedCalendarInput = {
  providerCalendarId: string;
  calendarName?: string | null;
};

type ProviderCalendarOption = {
  id: string;
  name: string | null;
  primary: boolean;
  selected: boolean;
};

type ConnectionSecret = {
  dataGeneration: number;
  status: string;
  refreshTokenEnc: string;
  /** fenced sync writer（#2050）が ready な時だけ非 undefined。 */
  authorityFenceId?: string;
  authorityEpoch?: number;
};

type LoadConnectionSecretOptions = {
  /**
   * fenced writer が ready でも authority fence（`authority_fence_id` /
   * `authority_epoch`）が NULL の行を「存在しない」と扱わず、fence 値を undefined に
   * したまま secret を返す（#2620）。
   *
   * **破壊的経路（disconnect）専用。** fence は fenced sync writer の CAS 入力なので、
   * CAS を伴う書き込み経路（`updateSelectedCalendars`）では既定の false のままにする。
   * disconnect は fence 値を一切使わず、DELETE も CAS ではなく
   * `id` + `user_id` の一致だけで行うため、ここで fence を要求しても守れる不変条件が無い。
   * 一方で要求すると、ユーザーが実行した取り消しが revoke も削除もせず成功を返す
   * （＝ provider 側の grant が生き続ける）。
   */
  allowMissingAuthorityFence?: boolean;
};

/** service_role で connection の token 行を読む。無ければ null。 */
async function loadConnectionSecret(
  db: CalendarConnectionClient,
  userId: string,
  connectionId: string,
  options: LoadConnectionSecretOptions = {},
): Promise<ConnectionSecret | null> {
  // #2050: この判定は `getConfiguredExternalLifecycleAppVersion`（Candidate 3 marker、
  // settings/billing 等の無関係な既存呼び出し元と共有）とは別関数に分離してある —
  // widen すると既存呼び出し元の RPC 呼び出し契約が変わり、無関係な test が regression
  // する（overview.md §0 改訂）。
  const fencedWriterReady = await isConfiguredFencedCalendarSyncWriterReady();
  if (fencedWriterReady) {
    // #2050 fenced writer 移行: replaceSelectedCalendars の CAS 入力に要る
    // authority_fence_id / authority_epoch も同時に読む。
    const { data, error } = await db
      .from(databaseTables.calendarConnections)
      .select('status, refresh_token_enc, data_generation, authority_fence_id, authority_epoch')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load calendar connection', {
        cause: error,
      });
    }
    if (!data) return null;
    if (data.authority_fence_id === null || data.authority_epoch === null) {
      // authority fence 未確立の接続（理論上は #2050 の CAS 対象外）。fenced writer
      // 呼び出しに必要な CAS 値が揃わないため missing 相当として扱う。
      //
      // ただし fence を使わない破壊的経路（disconnect）だけは例外にする（#2620）。
      // 接続作成経路（`saveConnection` / `reconnectExistingConnection`）は fence 列を
      // 書かないため、OAuth callback が作った行は必ずここに落ちる。missing 扱いのままだと
      // 切断が revoke も DELETE も飛ばして成功を返し、Google 側の grant が無期限に残る。
      if (!options.allowMissingAuthorityFence) return null;
      return {
        dataGeneration: data.data_generation,
        status: data.status,
        refreshTokenEnc: data.refresh_token_enc,
      };
    }
    return {
      dataGeneration: data.data_generation,
      status: data.status,
      refreshTokenEnc: data.refresh_token_enc,
      authorityFenceId: data.authority_fence_id,
      authorityEpoch: data.authority_epoch,
    };
  }

  const lifecycleVersion = await getConfiguredExternalLifecycleAppVersion();
  if (lifecycleVersion === 0) {
    const { data, error } = await db
      .from(databaseTables.calendarConnections)
      .select('status, refresh_token_enc')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load calendar connection', {
        cause: error,
      });
    }
    if (!data) return null;
    return {
      dataGeneration: 0,
      status: data.status,
      refreshTokenEnc: data.refresh_token_enc,
    };
  }

  const { data, error } = await db
    .from(databaseTables.calendarConnections)
    .select('status, refresh_token_enc, data_generation')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load calendar connection', {
      cause: error,
    });
  }
  if (!data) return null;
  return {
    dataGeneration: data.data_generation,
    status: data.status,
    refreshTokenEnc: data.refresh_token_enc,
  };
}

function throwForReauthOutcome(
  outcome: Awaited<ReturnType<typeof markCalendarConnectionReauth>>,
  cause?: unknown,
): never {
  if (outcome === 'marked') {
    throw new ExternalCalendarServiceError('REAUTH_REQUIRED', 'calendar connection needs reauth', {
      cause,
    });
  }
  if (outcome === 'missing') {
    throw new ExternalCalendarServiceError(
      'CONNECTION_NOT_FOUND',
      'calendar connection no longer exists',
    );
  }
  if (outcome === 'superseded') {
    throw new ExternalCalendarServiceError(
      'PROVIDER_UNAVAILABLE',
      'calendar connection changed while reauthorization was required',
    );
  }
  throw new ExternalCalendarServiceError(
    'UPDATE_FAILED',
    'calendar connection reauthorization is unresolved',
  );
}

/**
 * provider の calendarList をオンデマンドで取得し、選択済みフラグを付けて返す。
 *
 * refresh token を読むため service_role。`reauth_required` の接続は provider を叩かず弾く。
 * rotation された refresh token は保存し直す（Step 3 と同じ規律）。
 */
export async function listProviderCalendars(
  userId: string,
  connectionId: string,
  /**
   * `Date.now()` 換算の締切（ms）（#2079）。省略時は無制限（既存呼び出し互換）。
   * `sync-service.ts` の `syncConnection` と同じ形 — 呼び出し側（router.ts）が自分の
   * maxDuration に対する安全マージンを引いた値を渡す。
   */
  deadlineAt?: number | undefined,
): Promise<ProviderCalendarOption[]> {
  const db = createCalendarConnectionDbClient();

  const secret = await loadConnectionSecret(db, userId, connectionId);
  if (!secret) {
    throw new ExternalCalendarServiceError('CONNECTION_NOT_FOUND', 'calendar connection not found');
  }
  if (secret.status === 'reauth_required') {
    throw new ExternalCalendarServiceError('REAUTH_REQUIRED', 'calendar connection needs reauth');
  }

  const refreshToken = decryptToken(
    secret.refreshTokenEnc,
    env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
  );

  const rotationOperationId = randomUUID();
  let session;
  try {
    session = await googleCalendarAdapter.startSession(refreshToken);
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      const reauthOutcome = await markCalendarConnectionReauth({
        userId,
        connectionId,
        expectedGeneration: secret.dataGeneration,
        expectedRefreshTokenEnc: secret.refreshTokenEnc,
      });
      throwForReauthOutcome(reauthOutcome, error);
    }
    throw new ExternalCalendarServiceError('PROVIDER_UNAVAILABLE', 'failed to reach the provider', {
      cause: error,
    });
  }

  let markReauthAfterRotation: Awaited<
    ReturnType<typeof persistCalendarTokenRotation>
  >['markReauthIfCurrent'] = null;
  if (session.rotatedRefreshToken !== null) {
    const rotationResult = await persistCalendarTokenRotation({
      operationId: rotationOperationId,
      userId,
      connectionId,
      expectedGeneration: secret.dataGeneration,
      expectedRefreshTokenEnc: secret.refreshTokenEnc,
      rotatedRefreshToken: session.rotatedRefreshToken,
      encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
      provider: googleCalendarAdapter,
    });
    const { outcome: rotationOutcome } = rotationResult;
    markReauthAfterRotation = rotationResult.markReauthIfCurrent;

    if (rotationOutcome === 'enqueued' || rotationOutcome === 'missing') {
      throw new ExternalCalendarServiceError(
        'CONNECTION_NOT_FOUND',
        'calendar connection no longer exists',
      );
    }

    if (rotationOutcome === 'reauth_required') {
      throw new ExternalCalendarServiceError('REAUTH_REQUIRED', 'calendar connection needs reauth');
    }
    if (rotationOutcome === 'superseded') {
      throw new ExternalCalendarServiceError(
        'PROVIDER_UNAVAILABLE',
        'calendar connection changed while token rotation was recovered',
      );
    }
    if (rotationOutcome === 'unresolved') {
      throw new ExternalCalendarServiceError(
        'UPDATE_FAILED',
        'calendar token rotation is unresolved',
      );
    }
  }

  let providerCalendars;
  try {
    providerCalendars = await googleCalendarAdapter.listCalendars(session, deadlineAt);
  } catch (error) {
    if (error instanceof CalendarProviderError && error.kind === 'reauth_required') {
      const reauthOutcome =
        markReauthAfterRotation === null
          ? await markCalendarConnectionReauth({
              userId,
              connectionId,
              expectedGeneration: secret.dataGeneration,
              expectedRefreshTokenEnc: secret.refreshTokenEnc,
            })
          : await markReauthAfterRotation();
      throwForReauthOutcome(reauthOutcome, error);
    }
    // 予算切れは稀な異常（MAX_CALENDAR_LIST_PAGES=10 ページ分の calendarList を 60s で
    // 取り切れないのは、大量カレンダーか provider 側の劣化を示す）。一覧取得は部分結果を
    // 黙って返すと「これが全カレンダーだ」という誤認を招くため、明示的エラーへ変換する
    // （types.ts の CalendarProviderErrorKind 'deadline_exceeded' 参照、#2079。error-code-map.ts
    // の DEADLINE_EXCEEDED も同じ「稀な異常」という性格づけで Sentry 報告に乗せている）。
    if (error instanceof CalendarProviderError && error.kind === 'deadline_exceeded') {
      throw new ExternalCalendarServiceError(
        'DEADLINE_EXCEEDED',
        'listing provider calendars exceeded the wall-clock budget',
        { cause: error },
      );
    }
    throw error;
  }

  const { data: selectedRows, error: selectedError } = await db
    .from(databaseTables.calendarConnectionCalendars)
    .select('provider_calendar_id')
    .eq('connection_id', connectionId)
    .eq('user_id', userId);

  if (selectedError) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load selected calendars', {
      cause: selectedError,
    });
  }

  const selectedIds = new Set((selectedRows ?? []).map((row) => row.provider_calendar_id));

  return providerCalendars.map((calendar) => ({
    id: calendar.id,
    name: calendar.name,
    primary: calendar.primary,
    selected: selectedIds.has(calendar.id),
  }));
}

/**
 * 選択カレンダーを差し替える。
 *
 * 残すカレンダーの `sync_token` は保持する（upsert payload に含めないことで既存値が残る）。
 * 外したカレンダーは子行を delete し、そのミラー行のうち未参照のものを即時掃除する
 * （ユーザーが「外した」意思をすぐ反映。参照済みは歴史的アンカーとして残す）。
 */
export async function updateSelectedCalendars(
  userId: string,
  connectionId: string,
  selected: SelectedCalendarInput[],
): Promise<void> {
  const db = createCalendarConnectionDbClient();

  const secret = await loadConnectionSecret(db, userId, connectionId);
  if (!secret) {
    throw new ExternalCalendarServiceError('CONNECTION_NOT_FOUND', 'calendar connection not found');
  }

  const { authorityFenceId, authorityEpoch } = secret;
  if (authorityFenceId !== undefined && authorityEpoch !== undefined) {
    await updateSelectedCalendarsFenced({
      userId,
      connectionId,
      selected,
      dataGeneration: secret.dataGeneration,
      authorityFenceId,
      authorityEpoch,
    });
    return;
  }

  const { data: existingRows, error: existingError } = await db
    .from(databaseTables.calendarConnectionCalendars)
    .select('provider_calendar_id')
    .eq('connection_id', connectionId)
    .eq('user_id', userId);

  if (existingError) {
    throw new ExternalCalendarServiceError('FETCH_FAILED', 'failed to load selected calendars', {
      cause: existingError,
    });
  }

  const selectedIds = new Set(selected.map((calendar) => calendar.providerCalendarId));
  const removedIds = (existingRows ?? [])
    .map((row) => row.provider_calendar_id)
    .filter((id) => !selectedIds.has(id));

  if (selected.length > 0) {
    // sync_token をキーに含めない → 残す行の cursor は保持され、新規行だけ NULL（= 次回 full sync）。
    const { error: upsertError } = await db.from(databaseTables.calendarConnectionCalendars).upsert(
      selected.map((calendar) => ({
        user_id: userId,
        connection_id: connectionId,
        provider_calendar_id: calendar.providerCalendarId,
        calendar_name: calendar.calendarName ?? null,
      })),
      { onConflict: 'connection_id,provider_calendar_id' },
    );

    if (upsertError) {
      throw new ExternalCalendarServiceError('UPDATE_FAILED', 'failed to save selected calendars', {
        cause: upsertError,
      });
    }
  }

  if (removedIds.length > 0) {
    const { error: deleteError } = await db
      .from(databaseTables.calendarConnectionCalendars)
      .delete()
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .in('provider_calendar_id', removedIds);

    if (deleteError) {
      throw new ExternalCalendarServiceError('DELETE_FAILED', 'failed to remove calendars', {
        cause: deleteError,
      });
    }

    // 外したカレンダーの未参照ミラー行を即時掃除する。best-effort — 失敗しても選択変更
    // 自体は成功として扱う（fail-closed にすると cleanup 失敗がユーザー操作全体を巻き込む）。
    // 拾いきれなかった行は次回の window prune か disconnect の prune が回収する。
    try {
      await deleteUnreferencedEvents({
        userId,
        connectionId,
        scope: { kind: 'calendars', providerCalendarIds: removedIds },
      });
    } catch (error) {
      logger.warn('[calendar-connection] failed to prune events for removed calendars');
      captureUnexpectedError(error instanceof Error ? error : new Error('calendar prune failed'), {
        feature: 'external_calendar',
        operation: 'update_selected_calendars_prune',
      });
    }
  }
}

/**
 * `>= 2` 分岐: `replace_selected_calendars_command_v1` 1 回で選択差分の適用 + 外した
 * カレンダーの未参照ミラー行の anti-join prune をアトミックに行う（migration:839-854）。
 * v0/v1 分岐と異なり、app 層の `deleteUnreferencedEvents` は呼ばない（二重実行を避ける）。
 *
 * **fail-open → fail-closed への意味論変化を受容する**（overview.md §4）: v0/v1 の
 * prune は best-effort だったが、この RPC の DELETE は同一トランザクション
 * （`statement_timeout=30s`）内のため、外したカレンダーのミラー行が多い場合に
 * timeout（`57014`）で選択変更ごと rollback されうる。
 */
async function updateSelectedCalendarsFenced(params: {
  userId: string;
  connectionId: string;
  selected: SelectedCalendarInput[];
  dataGeneration: number;
  authorityFenceId: string;
  authorityEpoch: number;
}): Promise<void> {
  const { userId, connectionId, selected, dataGeneration, authorityFenceId, authorityEpoch } =
    params;

  const projectKey = resolveProjectKey();
  if (projectKey === null) {
    throw new ExternalCalendarServiceError(
      'UPDATE_FAILED',
      'google calendar authority identity is unset',
    );
  }

  const outcome = await replaceSelectedCalendars({
    connectionId,
    userId,
    projectKey,
    expectedGeneration: dataGeneration,
    expectedAuthorityFenceId: authorityFenceId,
    expectedAuthorityEpoch: authorityEpoch,
    selectedCalendars: selected.map((calendar) => ({
      providerCalendarId: calendar.providerCalendarId,
      calendarName: calendar.calendarName ?? null,
    })) as unknown as Json,
  });

  if (outcome === 'updated') return;
  if (outcome === 'missing') {
    throw new ExternalCalendarServiceError('CONNECTION_NOT_FOUND', 'calendar connection not found');
  }
  // 'superseded'（先行の sync run / 選択変更 / revoke に追い越された）、および
  // callTextRpc の failure（'unresolved' / 'rejected_input' / 'account_deleting'）を
  // まとめて再試行可能なエラーとして返す。未写像のまま無視すると選択変更が黙って
  // 消えるため、discriminant を必ず throw に写像する（overview.md §4、critic 指摘）。
  throw new ExternalCalendarServiceError(
    'UPDATE_FAILED',
    'failed to save selected calendars; please try again',
  );
}

/**
 * revoke できなかった refresh token を alert に回す。
 *
 * 切断自体は best-effort で続行する（ユーザーの意思を DB 側で止めない）が、失効しなかった
 * grant は「ユーザーは切ったつもりなのに Google 側は生きている」状態そのものなので、log
 * だけに残すと誰も気づけない。token rotation の補償（`token-rotation.ts`）が同じ条件で
 * capture しているのと揃える。message には token も connection id も載せない。
 */
function reportUnrevokedGrant(reason: string): void {
  logger.warn(`[calendar-connection] ${reason}; continuing disconnect`);
  captureUnexpectedError(new Error(`calendar disconnect left a provider grant alive: ${reason}`), {
    feature: 'external_calendar',
    operation: 'disconnect_revoke',
  });
}

/**
 * 接続を切断する（overview.md §8 の 3 段。順序が重要）。
 *
 * 1. 未参照ミラー行を anti-join で掃除する（connection を消す前に。削除後は FK が
 *    connection_id を NULL 化してスコープを失う）。**fail-closed**: 掃除が失敗したら
 *    revoke も connection 削除もせず throw する。ここだけは best-effort にしない — 削除後は
 *    FK が connection_id を NULL 化し、その未参照ミラー行を回収する経路が無くなる（#1988）。
 *    切断は冪等なので、ユーザーがもう一度実行すれば prune からやり直せる
 * 2. provider の revoke を best-effort で呼ぶ（失敗しても続行）。掃除より先に revoke すると、
 *    掃除が失敗した時に「token は失効済みなのに connection は active のまま」という
 *    authoritative state の食い違いが残る（Codex 指摘、#2000）。掃除を確実に終えてから
 *    revoke することでこの食い違いを避ける
 * 2.5. revoke の間（provider への network round-trip）に別プロセスの sync が新しい
 *    ミラー行を書き込む可能性が残る（sync-service.ts は disconnect 中の connection を
 *    CAS 検証せず書き込める。Codex 指摘、#2000。完全に閉じるには sync 側の fencing が要る
 *    — #2050 で追跡。fenced sync writer RPC 群の採用に一本化し、disconnect window の
 *    fencing もその受け入れ条件に含める）。ここでは delete 直前にもう一度掃除して race
 *    window を「revoke の所要時間」から「この 2 回目の DB 往復」まで縮める。**best-effort** — 1 回目の
 *    fail-closed で主要な保証は既に成立しているため、ここの失敗で切断全体を止めない
 * 3. `calendar_connections` を hard delete（子は CASCADE、参照済みミラーは connection_id が
 *    SET NULL され歴史的アンカーとして残る）
 *
 * 解約済みユーザーも切断できるよう protectedProcedure から呼ぶ。接続が既に無ければ冪等に成功。
 *
 * **authority fence の欠落で止まらない**（#2620）。`loadConnectionSecret` は fenced writer が
 * ready な時、`authority_fence_id` / `authority_epoch` が NULL の行を missing 相当として
 * null を返すが、disconnect は `allowMissingAuthorityFence` でその扱いを外す。fence を書く
 * 接続作成経路が存在しない以上、要求すると全ての新規接続で切断が空振りする。
 *
 * **revoke の失敗は削除を止めない**（上記 2 が best-effort である帰結を明示する）。provider が
 * revoke を拒否しても行は削除し、Sentry に `disconnect_revoke` を残す。ユーザーが実行した
 * 取り消しの主目的は Dayopt 側からのデータ・token の除去であり、そこを provider 応答に
 * 依存させると「切断できない接続」が生まれる。provider 側 grant の取りこぼしは Sentry で
 * 観測する（`revoke-outbox.ts` の再送は DB 起点の経路専用で、この関数からは enqueue しない）。
 *
 * **wall-clock 予算（deadline）は意図的に持たせていない**（#2079 で検討し、導入しない結論。
 * listProviderCalendars とは扱いを変える）:
 *
 * 1. 上記 1 の `deleteUnreferencedEvents` は idempotent。tRPC route の maxDuration=60 で
 *    kill されても、ユーザーが再実行すれば prune は続きから前進する。revoke は掃除完了後
 *    にしか呼ばれないため、kill 時に「token は生きているが connection は消えている」ような
 *    不整合状態は生まれない
 * 2. **先に効く制約は batch 上限ではなく wall-clock そのもの**（risk-reviewer 指摘で再導出、
 *    PR #2087 クロスレビュー）。`MAX_PRUNE_BATCHES_CONNECTION_SCOPE`（4,000）×
 *    `PRUNE_BATCH_SIZE`（150）＝60万行に到達するには DB 往復 24,000 回超を要し、60s では
 *    そもそも数百バッチ程度しか進まない。batch 上限は「実際に到達する worst case」では
 *    なく、真のページングバグに対する backstop でしかない（`event-pruning.ts` の同上限の
 *    コメント参照）。「±90 日 window で行数が有界」という見立ても誤り —
 *    `scope: { kind: 'connection' }` は window で絞らず、参照済み（plan/record が指す）行は
 *    削除対象外の歴史的アンカーとして残り続けるため、接続の生存期間とともに単調増加する
 * 3. kill された run の再実行は、未参照行が削除で候補集合から抜ける分だけ幾何級数的に
 *    収束するため安全側に振れる。ただし理論上は「参照済み行が候補の大半を占める」病的な
 *    ケースで収束しない穴が残る（現実的な行数では到達しないため受容する。誤った境界は
 *    境界が無いより危険という原則により、この残余を明記する — workflow.md
 *    §同型指摘の打ち切り 参照）。kill 直後の残骸状態が安全に収束することは個別に確認済み:
 *    revoke 済み・DB は active のまま connection 削除だけ残った状態でも、次回 cron sync が
 *    provider から reauth エラーを受けて `reauth_required` へ落とし、再度の disconnect で
 *    冪等に収束する。re-revoke（既に失効済みの token への 2 回目の revoke 呼び出し）は
 *    provider が `400 invalid_token` を返すが、`revokeRefreshToken`（google-oauth.ts）は
 *    これを成功として扱う
 * 4. deadline を導入すると「未完了のまま revoke/削除してよいか」という、上記 1 の
 *    fail-closed 保証（掃除失敗時は revoke も削除もしない）を弱める再設計になる。
 *    「未完了」を「失敗」と区別しない現在の設計をそのまま保つ
 */
export async function disconnect(userId: string, connectionId: string): Promise<void> {
  const db = createCalendarConnectionDbClient();

  // authority fence の欠落を「切断済み」と解釈しない（#2620）。fence が NULL でも
  // revoke と DELETE には必ず到達させる。行そのものが無い時だけ冪等に return する。
  const secret = await loadConnectionSecret(db, userId, connectionId, {
    allowMissingAuthorityFence: true,
  });
  if (!secret) return; // 既に切断済み。冪等。

  // 1. revoke より先にミラーを掃除する。失敗したら revoke も connection 削除もしない。
  try {
    await deleteUnreferencedEvents({ userId, connectionId, scope: { kind: 'connection' } });
  } catch (error) {
    throw new ExternalCalendarServiceError(
      'DELETE_FAILED',
      'failed to clean up calendar events before disconnecting',
      { cause: error },
    );
  }

  // 2. revoke（best-effort）。復号に失敗しても切断自体は続行する。
  try {
    const refreshToken = decryptToken(
      secret.refreshTokenEnc,
      env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
    );
    const revoked = await googleCalendarAdapter.revoke(refreshToken);
    if (!revoked) reportUnrevokedGrant('provider revoke was not confirmed');
  } catch {
    reportUnrevokedGrant('could not revoke the provider grant');
  }

  // 2.5. revoke 中に新規発生した差分を拾う best-effort な 2 回目の掃除。
  try {
    await deleteUnreferencedEvents({ userId, connectionId, scope: { kind: 'connection' } });
  } catch (error) {
    logger.warn('[calendar-connection] failed to re-prune events right before disconnect delete');
    captureUnexpectedError(error instanceof Error ? error : new Error('calendar prune failed'), {
      feature: 'external_calendar',
      operation: 'disconnect_reprune',
    });
  }

  // 3. connection を hard delete。子テーブルは CASCADE。
  const { error } = await db
    .from(databaseTables.calendarConnections)
    .delete()
    .eq('id', connectionId)
    .eq('user_id', userId);

  if (error) {
    throw new ExternalCalendarServiceError(
      'DELETE_FAILED',
      'failed to delete calendar connection',
      {
        cause: error,
      },
    );
  }
}

// =============================================================================
// #2072: OAuth 交換失敗時の orphan grant revoke
// =============================================================================

/**
 * 指定した Google account（`sub`）に対する **`active`** な `calendar_connections` 行が
 * どの Dayopt user にも存在しないかを確認する。
 *
 * #2280: 判定を `status` 問わず「行が存在するか」から `status = 'active'` に限定した。
 * `revokeOrphanedGrant` の呼び出し元（callback route の失敗パス）は、呼び出し時点で
 * 「この revoke 対象 token 自体は DB に一度も保存されていない」ことを**多くの場合**保証する
 * （scope 不足 / reconnect target 不在・不一致・missing のいずれも、書き込みが成立する前に
 * revoke へ分岐する）。ただし outer catch（保存 throw）経路では、DB 側は commit 済みで
 * レスポンス受信のみ失敗した（fetch timeout 等）ケースも throw に含まれるため、保存が実際に
 * 成立している可能性を完全には排除できない。その場合でも保存が成立していれば行は必ず
 * `status='active'` になるので、**この関数自身の active 判定が revoke を止める** —
 * 安全性は呼び出し元の保証ではなく、この存在確認そのものが担保している。したがってこの関数が
 * 答えるべき問いは「この token が保存されたか」ではなく、
 * **「revoke が他の生きた grant を巻き添えにしないか」** に絞ってよい。
 *
 * `revokeRefreshToken`（google-oauth.ts doc comment）は revoke を Google account ×
 * GCP project 単位で行うため、巻き添えの実害があるのは token が実際に有効な `active` 行に
 * 限られる。`reauth_required` 行（reconnect 対象自身を含む）の token は既に provider 側で
 * 死んでいる前提の行なので、巻き添えで無効化されても実害が無い。旧実装はこの区別をせず
 * 全 status を「存在する」に含めていたため、reconnect 対象の `reauth_required` 行自身が
 * 「接続あり」と誤判定させ、新規発行 token の revoke を skip していた（孤立残存）。
 *
 * `user_id` を条件に含めない: `calendar_connections` の UNIQUE 制約は
 * `user_id, provider, provider_account_id` で、同一 Google account を複数の異なる
 * Dayopt user が接続できる。`user_id` を条件に含めて「この user には行が無い」と判定すると、
 * 同じ Google account を繋いでいる別の Dayopt user の active 接続を巻き添えで失効させる。
 */
async function hasActiveConnectionForProviderAccount(providerAccountId: string): Promise<boolean> {
  const db = createCalendarConnectionDbClient();
  const { data, error } = await db
    .from(databaseTables.calendarConnections)
    .select('id')
    .eq('provider', GOOGLE_PROVIDER)
    .eq('provider_account_id', providerAccountId)
    .eq('status', 'active')
    .limit(1);

  if (error) {
    // 存在確認に失敗した場合は「存在する」扱いにして revoke を skip する（安全側に倒す）。
    logger.warn('[calendar-connection] failed to check for existing connections before revoke');
    return true;
  }

  return (data?.length ?? 0) > 0;
}

/**
 * OAuth callback が token 交換後（refresh token 発行後）に失敗した時、Dayopt 側に
 * どの接続行も残らない孤立 grant を best-effort で revoke する（#2072）。
 *
 * 同一 Google account の **active** 接続が 1 件でも残っていれば revoke しない（上記
 * `hasActiveConnectionForProviderAccount` 参照。#2280 で account 単位の存在確認から
 * active 限定へ変更した理由は同関数の docblock を参照）。結果に関わらず throw しない —
 * 呼び出し元の失敗 redirect フローを壊さない。失敗は `logger.warn` に留め Sentry へは送らない
 * （`disconnect` の `reportUnrevokedGrant` と異なり、こちらは元々失敗パスの中の
 * additional cleanup であり、主要フローの失敗ではないため）。
 *
 * **保証境界（TOCTOU、risk-reviewer 指摘）**: 存在確認と revoke の間（最大 30s）に、同じ
 * Google account を別タブ / 別 user が接続完了すると、その新しい接続の grant を巻き添えで
 * 失効させうる。provider 側に atomic な「確認 + revoke」操作が無いため構造的に閉じられない
 * 残余だが、回復可能（次回 sync が provider から reauth エラーを受けて対象接続を
 * `reauth_required` へ落とし、ユーザーの再認証で復帰する）。#2280 で active 限定にしたことに
 * より、この窓はわずかに広がっている: 存在確認より**前**の時点で、同一 account の別フロー
 * （別タブでの reconnect 等）が既に交換済みだが未保存の token を持っている場合、その token も
 * 巻き添えで失効しうる（旧実装では reconnect 対象の `reauth_required` 行の存在自体がこの窓を
 * 塞いでいた）。回復経路は同上。
 */
export async function revokeOrphanedGrant(params: {
  providerAccountId: string;
  refreshToken: string;
  /** 呼び出し元 route の残予算（epoch ms）。budget 不足なら revoke 自体を skip する。 */
  deadlineAt: number;
}): Promise<void> {
  if (
    params.deadlineAt - Date.now() <
    CALENDAR_CONNECTION_DB_TIMEOUT_MS + TOKEN_REQUEST_TIMEOUT_MS
  ) {
    logger.warn('[calendar-connection] insufficient time budget remaining; skipping orphan revoke');
    return;
  }

  try {
    const hasConnection = await hasActiveConnectionForProviderAccount(params.providerAccountId);
    if (hasConnection) return;

    const revoked = await googleCalendarAdapter.revoke(params.refreshToken);
    if (!revoked) {
      logger.warn('[calendar-connection] orphan grant revoke was not confirmed');
    }
  } catch {
    logger.warn('[calendar-connection] failed to revoke orphan grant');
  }
}
