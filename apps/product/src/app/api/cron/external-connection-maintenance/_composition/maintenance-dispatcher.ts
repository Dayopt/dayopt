import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import {
  MIN_RUN_BUDGET_MS,
  processCalendarRevokeOutbox,
  type CalendarRevokeOutboxSummary,
} from '@/features/external-calendar/server/revoke-outbox';
import { cleanupBillingAccountDeletionTerminalReceipts } from '@/features/settings/server/account-deletion';
import { cleanupBillingMutationClaims } from '@/features/settings/server/billing-mutation-service';
import {
  getExternalLifecycleAppVersion,
  isPredecessorMissingFunction,
} from '@/lib/database/external-lifecycle-version';
import type { Database } from '@/lib/database/generated/database.types';
import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

const CLEANUP_BATCH_SIZE = 250;
const DB_RPC_TIMEOUT_MS = 3_000;

// billing 側 2 本の cleanup は feature 側で自前の timeout を持つ
// （`billing-mutation-service.ts` の BILLING_CLEANUP_TIMEOUT_MS と
// `account-deletion.ts` の DB_RPC_TIMEOUT_MS、いずれも 4s）。retention の予算計算で
// この 2 本を数えるためにここへ写す。片方を変えたらここも合わせる。
const BILLING_CLEANUP_TIMEOUT_MS = 4_000;
const BILLING_CLEANUP_STEP_COUNT = 2;

/**
 * どの retention 区分に期限超過 backlog が残っているか。`hasMore` が true の時に
 * 「何が残っているか」を ID 抜きで示し、cron の warn ログを識別可能にする。
 */
type RetentionDueSummary = {
  authorizationCodes: boolean;
  accessTokens: boolean;
  refreshTokens: boolean;
  connections: boolean;
  receipts: boolean;
  securityEvents: boolean;
  billingClaims: boolean;
  billingDeletionReceipts: boolean;
};

type RetentionSummary = {
  oauthAuthorizationCodesDeleted: number;
  oauthAccessTokensDeleted: number;
  oauthRefreshTokensDeleted: number;
  oauthConnectionsDeleted: number;
  billingClaimsDeleted: number;
  billingDeletionReceiptsDeleted: number;
  billingProviderResponsesRedacted: number;
  securityEventsDeleted: number;
  mcpMutationReceiptsDeleted: number;
  due: RetentionDueSummary;
  hasMore: boolean;
};

const NO_RETENTION_DUE: RetentionDueSummary = {
  authorizationCodes: false,
  accessTokens: false,
  refreshTokens: false,
  connections: false,
  receipts: false,
  securityEvents: false,
  billingClaims: false,
  billingDeletionReceipts: false,
};

type PublicOutboxSummary = Omit<
  CalendarRevokeOutboxSummary,
  'encryptionAvailable' | 'deadlineReached'
> & {
  due: number;
  total: number;
  oldestDueAgeSeconds: number;
  deferred: number;
  revokeUnavailable: boolean;
};

type ExternalConnectionMaintenanceSummary = {
  /** migration未適用等で保守処理を実行できない。heartbeatの成功と区別する。 */
  schemaUnavailable?: true;
  complete: boolean;
  outbox: PublicOutboxSummary;
  retention: RetentionSummary;
  /**
   * `finalize-calendar-revoke-guards` cron 側で 24h 超 guard されたまま滞留している件数
   * （#2055(a)）。この cron からは解消できない別 cron の backlog なので `retention.due` /
   * `hasMore` / `complete` には混ぜず、独立フィールドとして持つ。
   */
  calendarFinalizeStuck: number;
  durationMs: number;
};

type CleanupFunction =
  | 'cleanup_oauth_authorization_codes_v1'
  | 'cleanup_oauth_access_tokens_v1'
  | 'cleanup_oauth_refresh_tokens_v1'
  | 'cleanup_oauth_connections_v1'
  | 'cleanup_integration_security_events_v1'
  | 'cleanup_mcp_mutation_receipts_v1';

type RetentionCountKey = keyof Omit<RetentionSummary, 'due' | 'hasMore'>;

/**
 * authorization_codes / access_tokens / refresh_tokens を先に、connections を最後に呼ぶ
 * （保持期間の短い順 = 子から親）。connections の複合 FK は ON DELETE CASCADE なので順序が
 * 入れ替わっても不整合にはならないが、connection が due になる頃には配下の token/code は
 * 自身の期限で既に消えているのが通常パスなので、この順にしておくと cascade に頼る行が
 * 実運用ではほぼ出ない（#1898）。どの区分が残っているかは retention.due として summary に
 * 出し、warn ログで「retention backlog」と「calendar outbox の滞留」を区別できるようにする。
 *
 * module scope に置いているのは、下の RETENTION_BUDGET_MS を**本数から導出**するため。
 * 予算を数値リテラルで持つと、step を足した時に予算だけ据え置かれる（#1898 で実際に
 * 2 本 → 6 本へ増えた）。
 */
const CLEANUP_STEPS: ReadonlyArray<{
  key: RetentionCountKey;
  operation: CleanupFunction;
}> = [
  { key: 'oauthAuthorizationCodesDeleted', operation: 'cleanup_oauth_authorization_codes_v1' },
  { key: 'oauthAccessTokensDeleted', operation: 'cleanup_oauth_access_tokens_v1' },
  { key: 'oauthRefreshTokensDeleted', operation: 'cleanup_oauth_refresh_tokens_v1' },
  { key: 'oauthConnectionsDeleted', operation: 'cleanup_oauth_connections_v1' },
  { key: 'securityEventsDeleted', operation: 'cleanup_integration_security_events_v1' },
  { key: 'mcpMutationReceiptsDeleted', operation: 'cleanup_mcp_mutation_receipts_v1' },
];

/**
 * retention が全 RPC を timeout まで使い切った時の所要（cleanup RPC 各本 + 最後の status
 * 読み取り + billing 側 2 本）。予算そのものではなく、下の 2 つの不等式を検査するための値。
 */
export const RETENTION_WORST_CASE_MS =
  (CLEANUP_STEPS.length + 1) * DB_RPC_TIMEOUT_MS +
  BILLING_CLEANUP_STEP_COUNT * BILLING_CLEANUP_TIMEOUT_MS;

/**
 * calendar outbox から取り上げて retention へ回す時間。**両側から挟まれている**:
 *
 * - 小さすぎると retention が route の `maxDuration` を跨いで途中で kill される
 *   （残った due flag は次回 cron が拾うので fail closed ではあるが、恒常化させない）
 * - **大きすぎると outbox が死ぬ**。`processCalendarRevokeOutbox` は残り時間が
 *   `MIN_BATCH_BUDGET_MS` を割ると 1 件も claim せずに break するため、取り分を
 *   増やしすぎると calendar revoke request が provider へ永久に送られなくなる
 *
 * 後者は「retention の worst case をそのまま予約する」と実際に踏む（50s - 29s = 21s <
 * 23s）。予約は worst case ではなくこの固定値とし、worst case を超過した分は
 * `maxDuration` までの余白（`route.ts` の 60s）で吸収する。下の `Math.max` が
 * outbox の下限を機械的に守る。
 */
const RETENTION_BUDGET_MS = 23_000;

class ExternalConnectionMaintenanceError extends Error {
  readonly code: string;

  constructor(operation: string) {
    super('External connection maintenance failed');
    this.name = 'ExternalConnectionMaintenanceError';
    this.code = `EXTERNAL_CONNECTION_${operation.toUpperCase()}_FAILED`;
  }
}

/**
 * cleanup RPC を 1 本呼ぶ。関数がまだ存在しない schema では `null` を返す。
 *
 * `get_external_lifecycle_app_version_v2` の marker は **その RPC 自体の不在**でしか
 * predecessor を判定しないため、marker を返す schema（= 現 production）にこの PR の
 * migration が未適用でも lifecycle の分岐は predecessor 側へ落ちない。app が migration
 * より先に deploy された場合や DB を直前版へ復元した場合、存在しない RPC の
 * `PGRST202` / `42883` を failure として扱うと cron が毎回 500 になる。
 *
 * 未実装は failure ではなく「まだ実行できない」として扱う。削除は起きないので due flag は
 * 立ったままになり、`hasMore` → `complete: false` で fail closed の報告は維持される。
 */
async function cleanup(
  db: SupabaseClient<Database>,
  operation: CleanupFunction,
): Promise<number | null> {
  try {
    const { data, error } = await db
      .rpc(operation, { p_limit: CLEANUP_BATCH_SIZE })
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS));
    if (error) {
      if (isPredecessorMissingFunction(error)) return null;
      throw new ExternalConnectionMaintenanceError(operation);
    }
    if (typeof data !== 'number') {
      throw new ExternalConnectionMaintenanceError(operation);
    }
    return data;
  } catch (error) {
    if (error instanceof ExternalConnectionMaintenanceError) throw error;
    if (isPredecessorMissingFunction(error)) return null;
    throw new ExternalConnectionMaintenanceError(operation);
  }
}

async function readStatus(db: SupabaseClient<Database>) {
  try {
    const { data, error } = await db
      .rpc('get_external_authority_maintenance_status_v1')
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS));
    const status = data?.[0];
    if (error || status === undefined) {
      throw new ExternalConnectionMaintenanceError('status');
    }
    return status;
  } catch (error) {
    if (error instanceof ExternalConnectionMaintenanceError) throw error;
    throw new ExternalConnectionMaintenanceError('status');
  }
}

/**
 * Calendar provider revoke と外部依存 retention を 1 本の cron で実行する。
 *
 * outbox 側が失敗しても retention は試す。逆も同様で、1 種類の cleanup failure が他の
 * 保持期限を無期限に延ばさないよう、最初の安全化済み error だけを最後に再送出する。
 */
export async function dispatchExternalConnectionMaintenance(params: {
  deadlineAt: number;
}): Promise<ExternalConnectionMaintenanceSummary> {
  const startedAt = Date.now();
  let db: SupabaseClient<Database>;
  try {
    db = createServiceRoleClient();
  } catch {
    throw new ExternalConnectionMaintenanceError('client');
  }

  const lifecycleVersion = await getExternalLifecycleAppVersion(db);
  if (lifecycleVersion === 0) {
    const predecessorSummary: ExternalConnectionMaintenanceSummary = {
      schemaUnavailable: true,
      complete: false,
      outbox: {
        claimed: 0,
        revoked: 0,
        retried: 0,
        expired: 0,
        alreadyGone: 0,
        due: 0,
        total: 0,
        oldestDueAgeSeconds: 0,
        deferred: 0,
        revokeUnavailable: false,
      },
      retention: {
        oauthAuthorizationCodesDeleted: 0,
        oauthAccessTokensDeleted: 0,
        oauthRefreshTokensDeleted: 0,
        oauthConnectionsDeleted: 0,
        billingClaimsDeleted: 0,
        billingDeletionReceiptsDeleted: 0,
        billingProviderResponsesRedacted: 0,
        securityEventsDeleted: 0,
        mcpMutationReceiptsDeleted: 0,
        due: NO_RETENTION_DUE,
        hasMore: false,
      },
      calendarFinalizeStuck: 0,
      durationMs: Date.now() - startedAt,
    };
    logger.info(
      '[external-connection-maintenance] predecessor schema; maintenance deferred',
      predecessorSummary,
    );
    return predecessorSummary;
  }

  let firstFailure: Error | null = null;
  let outbox: CalendarRevokeOutboxSummary = {
    claimed: 0,
    revoked: 0,
    retried: 0,
    expired: 0,
    alreadyGone: 0,
    deadlineReached: false,
    encryptionAvailable: false,
  };

  // retention の取り分を増やした結果 outbox が 1 batch も回せなくなる（= calendar revoke が
  // 永久に送られない）事故を機械的に防ぐ。retention 側の予算計算が将来変わっても、outbox の
  // 下限だけは必ず残す。
  // 下限は `startedAt` ではなく現在時刻から測る。`startedAt` 以降に lifecycle version の
  // RPC が 1 本走っているため、`startedAt` 基準だとガードが効いた時に実残時間が下限へ
  // 届かず、防ごうとした「0 件 claim」がそのまま起きる。下限に使うのは 1 batch 分
  // （MIN_BATCH_BUDGET_MS）ではなく MIN_RUN_BUDGET_MS で、outbox が claim 前に走らせる
  // expire RPC の分を含んでいる。
  const outboxDeadlineAt = Math.max(
    params.deadlineAt - RETENTION_BUDGET_MS,
    Date.now() + MIN_RUN_BUDGET_MS,
  );

  try {
    outbox = await processCalendarRevokeOutbox({
      encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY,
      deadlineAt: outboxDeadlineAt,
    });
  } catch {
    // feature 側は安全化済み error を返すが、将来の変更でも raw DB/provider error を
    // route / Sentry へ通さないよう Composition Layer でも固定メッセージへ置き換える。
    firstFailure = new ExternalConnectionMaintenanceError('outbox');
  }

  const retention: Omit<RetentionSummary, 'due' | 'hasMore'> = {
    oauthAuthorizationCodesDeleted: 0,
    oauthAccessTokensDeleted: 0,
    oauthRefreshTokensDeleted: 0,
    oauthConnectionsDeleted: 0,
    billingClaimsDeleted: 0,
    billingDeletionReceiptsDeleted: 0,
    billingProviderResponsesRedacted: 0,
    securityEventsDeleted: 0,
    mcpMutationReceiptsDeleted: 0,
  };

  let schemaUnavailable = false;
  for (const step of CLEANUP_STEPS) {
    try {
      // null は「その schema に関数がまだ無い」。件数 0 のまま進めれば due flag が残り、
      // complete: false として報告される（migration 適用後に自然に解消する）。
      const deleted = await cleanup(db, step.operation);
      if (deleted === null) schemaUnavailable = true;
      retention[step.key] = deleted ?? 0;
    } catch (error) {
      firstFailure ??=
        error instanceof Error ? error : new ExternalConnectionMaintenanceError(step.operation);
    }
  }

  let billingMutationHasMore = false;
  try {
    const billingMutation = await cleanupBillingMutationClaims(db, {
      limit: CLEANUP_BATCH_SIZE,
    });
    retention.billingClaimsDeleted = billingMutation.claimsDeleted;
    retention.billingProviderResponsesRedacted = billingMutation.providerResponsesRedacted;
    billingMutationHasMore = billingMutation.hasMore;
  } catch {
    firstFailure ??= new ExternalConnectionMaintenanceError('billing_mutation_cleanup');
  }

  let billingDeletionReceiptsHaveMore = false;
  try {
    const billingDeletionReceipts = await cleanupBillingAccountDeletionTerminalReceipts(db, {
      limit: CLEANUP_BATCH_SIZE,
    });
    retention.billingDeletionReceiptsDeleted = billingDeletionReceipts.deleted;
    billingDeletionReceiptsHaveMore = billingDeletionReceipts.hasMore;
  } catch {
    firstFailure ??= new ExternalConnectionMaintenanceError('billing_deletion_receipt_cleanup');
  }

  let status: Awaited<ReturnType<typeof readStatus>>;
  try {
    status = await readStatus(db);
  } catch (error) {
    firstFailure ??=
      error instanceof Error ? error : new ExternalConnectionMaintenanceError('status');
    throw firstFailure;
  }

  if (firstFailure !== null) throw firstFailure;

  const due: RetentionDueSummary = {
    authorizationCodes: status.authorization_codes_due,
    accessTokens: status.access_tokens_due,
    refreshTokens: status.refresh_tokens_due,
    connections: status.connections_due,
    receipts: status.receipts_due,
    securityEvents: status.security_events_due,
    billingClaims: billingMutationHasMore,
    billingDeletionReceipts: billingDeletionReceiptsHaveMore,
  };
  const hasMore = Object.values(due).some(Boolean);
  const revokeUnavailable = !outbox.encryptionAvailable && status.calendar_revoke_total > 0;
  const complete =
    !schemaUnavailable &&
    outbox.expired === 0 &&
    outbox.retried === 0 &&
    !outbox.deadlineReached &&
    status.calendar_revoke_total === 0 &&
    !hasMore;
  // predecessor schema（新列が無い）は number | undefined になりうる。実行時 fallback で吸収する。
  const calendarFinalizeStuck = Number(status.calendar_finalize_stuck_count ?? 0);

  const summary: ExternalConnectionMaintenanceSummary = {
    ...(schemaUnavailable ? { schemaUnavailable: true as const } : {}),
    complete,
    outbox: {
      claimed: outbox.claimed,
      revoked: outbox.revoked,
      retried: outbox.retried,
      expired: outbox.expired,
      alreadyGone: outbox.alreadyGone,
      due: status.calendar_revoke_due,
      total: status.calendar_revoke_total,
      oldestDueAgeSeconds: status.oldest_due_age_seconds,
      deferred: status.calendar_revoke_due,
      revokeUnavailable,
    },
    retention: {
      ...retention,
      due,
      hasMore,
    },
    calendarFinalizeStuck,
    durationMs: Date.now() - startedAt,
  };

  logger.info('[external-connection-maintenance] dispatch finished', summary);
  return summary;
}
