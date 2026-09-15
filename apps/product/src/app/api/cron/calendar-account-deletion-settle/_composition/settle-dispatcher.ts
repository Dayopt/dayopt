import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveGoogleCalendarAuthorityIdentity } from '@/features/external-calendar/server/authority-config';
import {
  getExternalLifecycleAppVersion,
  isPredecessorMissingFunction,
  VERSION_RPC_TIMEOUT_MS,
} from '@/lib/database/external-lifecycle-version';
import type { Database } from '@/lib/database/generated/database.types';
import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

// account_delete 種別の pending intent（`expires_at` を過ぎても `preparing` のまま残った行）を
// settle する経路（#2055(b)）。当初は `external-connection-maintenance` cron に同居させる
// 設計だったが、その cron の時間予算には実測 1000ms の余白しか無く、list + normalize の
// 現実的な RPC timeout を追加する余地が構造的に無かった（round 2 review 後の実装検証で判明、
// #2055 コメント参照）。この cron を独立させたことで、予算はここだけで完結する。
//
// `list_expired_calendar_account_deletion_intents_v1` →
// `normalize_calendar_account_deletion_intent_v1` は 1 RPC = 1 トランザクションが設計上の
// 前提（`private.normalize_calendar_account_deletion_intent_v1` が
// `lock_timeblock_user_write_exclusive_v1` 経由で呼ぶ `bind_timeblock_supported_writer_v1` は
// 同一トランザクション内で 2 人目の user を bind すると例外になる）。そのため候補ごとに
// RPC 往復が要る。
// SQL 側の lock_timeout（下記）を client の abort timeout が下回らないよう先に timeout を
// 決め、そこから 1 run あたりの件数を予算（TIME_BUDGET_MS = 50s、route.ts）に収まるよう絞る
// （7s * 5 件 + list 3s + version 3s = 41s、余白 9s）。
const ACCOUNT_DELETION_SETTLE_LIST_TIMEOUT_MS = 3_000;
// `private.normalize_calendar_account_deletion_intent_v1` は `SET lock_timeout = '5s'`
// （20260730090016）。client 側の abort timeout をこれより短くすると、DB 側が正常に
// lock 待ちを継続しているところを client が先に打ち切ってしまい、lock 競合が起きた候補が
// 毎 run 先頭で abort → エラー扱いになって進捗しなくなる（risk-reviewer 指摘）。SQL の
// lock_timeout より確実に長い値にする。
const ACCOUNT_DELETION_SETTLE_TIMEOUT_MS = 7_000;
const ACCOUNT_DELETION_SETTLE_MAX = 5;

/**
 * この cron が 1 run で使い切りうる worst case。list 1 本 + normalize 最大
 * ACCOUNT_DELETION_SETTLE_MAX 本に加え、settle 本体の前に必ず 1 回走る lifecycle version
 * RPC（`getExternalLifecycleAppVersion`）も含める。`isWriteFenceEnabled` は route.ts 側で
 * `deadlineAt` 計算より前に走るため、他の cron route（`external-connection-maintenance`）
 * と同様この値には含まない（`TIME_BUDGET_MS` と `maxDuration` の間の hard-kill margin が
 * 実質的にそちらを吸収する。route.test.ts が実測で固定する）。
 */
export const SETTLE_WORST_CASE_MS =
  VERSION_RPC_TIMEOUT_MS +
  ACCOUNT_DELETION_SETTLE_LIST_TIMEOUT_MS +
  ACCOUNT_DELETION_SETTLE_MAX * ACCOUNT_DELETION_SETTLE_TIMEOUT_MS;

/**
 * `normalize_calendar_account_deletion_intent_v1` の戻り値（`missing` / `ready` / `active` /
 * `in_flight` / `normalized`）のうち `normalized` だけを数えると、`in_flight`（provider attempt
 * が 10 分窓を超えて残る状態）が恒久化しても「毎時 0 件・エラーなし」に見えてしまうため、
 * 戻り値ごとに件数を分ける。
 */
type AccountDeletionSettleSummary = {
  normalized: number;
  inFlight: number;
  other: number;
  /** authority identity（project key）が未設定でこの run は何もしなかった。 */
  skipped: boolean;
  durationMs: number;
};

const NO_ACCOUNT_DELETION_SETTLE: Omit<AccountDeletionSettleSummary, 'durationMs'> = {
  normalized: 0,
  inFlight: 0,
  other: 0,
  skipped: false,
};

/**
 * `causeCode`/`causeMessage` は #2289（DAYOPT-X）と同型の診断可能性の穴（DAYOPT-V、#2305）を
 * 塞ぐために持たせる。以前はここで原因（DB / provider の raw error）を握りつぶし、stage 名
 * だけの `code` に丸めていたため、route.ts 側で generic dispatch failure としか観測できず
 * 真因が Sentry 上で完全に不可視だった。`route.ts` はこれを `errorCode`/`errorMessage` として
 * `captureUnexpectedError` へ伝搬し、`packages/observability/src/sanitize.ts` の
 * `sanitizeErrorMessage`（default-closed allowlist）を通してから送信する。allowlist 外の
 * 内容は `[UNRECOGNIZED_ERROR_MESSAGE]` に落ちるため、ここで raw message を保持しても
 * 送信経路の安全性は sanitizer 側が担保する。
 */
export class CalendarAccountDeletionSettleError extends Error {
  readonly code: string;
  readonly causeCode: string | undefined;
  readonly causeMessage: string | undefined;

  constructor(operation: string, cause?: { code?: string; message?: string }) {
    super('Calendar account deletion settle failed');
    this.name = 'CalendarAccountDeletionSettleError';
    this.code = `ACCOUNT_DELETION_SETTLE_${operation.toUpperCase()}_FAILED`;
    this.causeCode = cause?.code;
    this.causeMessage = cause?.message;
  }
}

/**
 * account_delete 種別の pending intent を settle する。1 RPC = 1 トランザクションが前提の
 * ため候補ごとに順次呼び、`external-connection-maintenance` の `CLEANUP_STEPS` ループと
 * 同じ「例外を集約しつつ次候補へ進む」パターンで、1 件の失敗が他候補の処理を止めないように
 * する。deadline を割ったら残りは次回 run へ繰り越す（打ち切り自体は失敗ではないので
 * throw しない。進捗ログのみ）。
 */
export async function dispatchCalendarAccountDeletionSettle(params: {
  deadlineAt: number;
}): Promise<AccountDeletionSettleSummary> {
  const startedAt = Date.now();
  let db: SupabaseClient<Database>;
  try {
    db = createServiceRoleClient();
  } catch (error) {
    throw new CalendarAccountDeletionSettleError(
      'client',
      error instanceof Error ? { message: error.message } : undefined,
    );
  }

  const lifecycleVersion = await getExternalLifecycleAppVersion(db);
  if (lifecycleVersion === 0) {
    const summary: AccountDeletionSettleSummary = {
      ...NO_ACCOUNT_DELETION_SETTLE,
      skipped: true,
      durationMs: Date.now() - startedAt,
    };
    logger.info('[calendar-account-deletion-settle] predecessor schema; settle deferred', summary);
    return summary;
  }

  const projectKey = resolveGoogleCalendarAuthorityIdentity()?.projectKey;
  if (projectKey === undefined || projectKey === null) {
    logger.warn(
      '[calendar-account-deletion-settle] google calendar authority identity is unset; settle skipped',
    );
    const summary: AccountDeletionSettleSummary = {
      ...NO_ACCOUNT_DELETION_SETTLE,
      skipped: true,
      durationMs: Date.now() - startedAt,
    };
    return summary;
  }

  const { data: candidates, error: listError } = await db
    .rpc('list_expired_calendar_account_deletion_intents_v1', {
      p_project_key: projectKey,
      p_limit: ACCOUNT_DELETION_SETTLE_MAX,
    })
    .abortSignal(AbortSignal.timeout(ACCOUNT_DELETION_SETTLE_LIST_TIMEOUT_MS));

  if (listError) {
    if (isPredecessorMissingFunction(listError)) {
      return { ...NO_ACCOUNT_DELETION_SETTLE, skipped: true, durationMs: Date.now() - startedAt };
    }
    // CA010 = この project key で activated な Calendar authority project が無い（#2748）。
    // intent は active project の fence にしか紐付かないため settle 対象は構造上 0 件で、
    // 失敗ではなく 0 件の完了として扱う。未 provision の production で毎時 DAYOPT-V を出し
    // heartbeat の completion を欠かしていた。pg_cron 側の authority job も同じ状態を
    // 0 行 no-op にしている（20260813130000）。activation 後の project key 不一致も CA010 に
    // なるが、同じ fence を解決する Calendar sync / revoke writer が同時に失敗するので、
    // この cron だけが唯一の観測点ではない。
    if (listError.code === 'CA010') {
      const summary: AccountDeletionSettleSummary = {
        ...NO_ACCOUNT_DELETION_SETTLE,
        durationMs: Date.now() - startedAt,
      };
      logger.info(
        '[calendar-account-deletion-settle] calendar authority project is not active; nothing to settle',
        summary,
      );
      return summary;
    }
    throw new CalendarAccountDeletionSettleError('list', {
      code: listError.code,
      message: listError.message,
    });
  }

  const result = { ...NO_ACCOUNT_DELETION_SETTLE };
  let firstError: Error | null = null;

  for (const candidate of candidates ?? []) {
    if (params.deadlineAt - Date.now() < ACCOUNT_DELETION_SETTLE_TIMEOUT_MS) {
      logger.warn(
        '[calendar-account-deletion-settle] deadline reached; remaining candidates deferred',
      );
      break;
    }

    try {
      const { data, error } = await db
        .rpc('normalize_calendar_account_deletion_intent_v1', {
          p_project_key: projectKey,
          p_user_id: candidate.user_id,
          p_deletion_id: candidate.deletion_id,
        })
        .abortSignal(AbortSignal.timeout(ACCOUNT_DELETION_SETTLE_TIMEOUT_MS));

      if (error) {
        if (isPredecessorMissingFunction(error)) {
          result.skipped = true;
          continue;
        }
        throw new CalendarAccountDeletionSettleError('normalize', {
          code: error.code,
          message: error.message,
        });
      }

      if (data === 'normalized') {
        result.normalized += 1;
      } else if (data === 'in_flight') {
        result.inFlight += 1;
      } else {
        result.other += 1;
      }
    } catch (error) {
      // CalendarAccountDeletionSettleError はそのまま（cause 情報は既に載っている）。
      // 未分類の例外（abortSignal タイムアウト等）は message を cause として引き継ぐ。
      firstError ??=
        error instanceof CalendarAccountDeletionSettleError
          ? error
          : new CalendarAccountDeletionSettleError(
              'normalize',
              error instanceof Error ? { message: error.message } : undefined,
            );
    }
  }

  const summary: AccountDeletionSettleSummary = { ...result, durationMs: Date.now() - startedAt };
  logger.info('[calendar-account-deletion-settle] dispatch finished', summary);

  if (firstError !== null) throw firstError;

  return summary;
}
