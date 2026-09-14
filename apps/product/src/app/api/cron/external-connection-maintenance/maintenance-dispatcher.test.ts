import { beforeEach, describe, expect, it, vi } from 'vitest';

const processCalendarRevokeOutbox = vi.hoisted(() => vi.fn());
const cleanupBillingAccountDeletionTerminalReceipts = vi.hoisted(() => vi.fn());
const cleanupBillingMutationClaims = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const createServiceRoleClient = vi.hoisted(() => vi.fn(() => ({ rpc })));
const loggerInfo = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () =>
    ({ CALENDAR_TOKEN_ENCRYPTION_KEY: 'test-key' }) as {
      CALENDAR_TOKEN_ENCRYPTION_KEY?: string | undefined;
    },
);

vi.mock('@/env', () => ({ env: envMock }));
// MIN_RUN_BUDGET_MS は dispatcher が outbox の下限を守るために読む実値（1 batch 分の
// MIN_BATCH_BUDGET_MS に、claim 前に走る expire RPC の timeout と I/O を伴わない startup の
// 固定コストを足したもの）。mock で落とすと不変条件のテストが意味を失うので、feature 側の値を
// そのまま写す。実値は revoke-outbox.test.ts が pin している。
const MIN_RUN_BUDGET_MS = 27_000;
vi.mock('@/features/external-calendar/server/revoke-outbox', () => ({
  processCalendarRevokeOutbox,
  MIN_RUN_BUDGET_MS: 27_000,
}));
vi.mock('@/features/settings/server/account-deletion', () => ({
  cleanupBillingAccountDeletionTerminalReceipts,
}));
vi.mock('@/features/settings/server/billing-mutation-service', () => ({
  cleanupBillingMutationClaims,
}));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));
vi.mock('@/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: loggerInfo,
    debug: vi.fn(),
  },
}));

import {
  dispatchExternalConnectionMaintenance,
  RETENTION_WORST_CASE_MS,
} from './_composition/maintenance-dispatcher';

const FAR_DEADLINE = 10 ** 15;

// route.ts の `TIME_BUDGET_MS` と `maxDuration`（秒）。route.ts を import すると mock して
// いない依存まで引き込むため値を写す。route.test.ts 側で実値を pin してある。
const CRON_TIME_BUDGET_MS = 50_000;
const CRON_MAX_DURATION_MS = 60 * 1_000;
// `external-lifecycle-version.ts` の VERSION_RPC_TIMEOUT_MS。outbox の下限ガードは
// この RPC の後に現在時刻から測るため、最悪ケースの起点になる。
const LIFECYCLE_RPC_TIMEOUT_MS = 3_000;

const OUTBOX_SUMMARY = {
  claimed: 4,
  revoked: 2,
  retried: 1,
  expired: 1,
  alreadyGone: 1,
  deadlineReached: false,
  encryptionAvailable: true,
};

const STATUS = {
  calendar_revoke_due: 3,
  calendar_revoke_total: 5,
  oldest_due_age_seconds: 45,
  authorization_codes_due: false,
  access_tokens_due: false,
  refresh_tokens_due: true,
  connections_due: false,
  receipts_due: false,
  security_events_due: false,
  calendar_finalize_stuck_count: 0,
};

const CLEAN_STATUS = {
  ...STATUS,
  calendar_revoke_due: 0,
  calendar_revoke_total: 0,
  oldest_due_age_seconds: 0,
  authorization_codes_due: false,
  access_tokens_due: false,
  refresh_tokens_due: false,
  connections_due: false,
  receipts_due: false,
  security_events_due: false,
  calendar_finalize_stuck_count: 0,
};

const CLEAN_OUTBOX = {
  ...OUTBOX_SUMMARY,
  claimed: 0,
  revoked: 0,
  retried: 0,
  expired: 0,
  alreadyGone: 0,
  deadlineReached: false,
};

const CLEANUP_COUNTS: Record<string, number> = {
  cleanup_oauth_authorization_codes_v1: 1,
  cleanup_oauth_access_tokens_v1: 2,
  cleanup_oauth_refresh_tokens_v1: 3,
  cleanup_oauth_connections_v1: 4,
  cleanup_mcp_mutation_receipts_v1: 5,
  cleanup_integration_security_events_v1: 6,
};

function setupRpc(status = STATUS): void {
  rpc.mockImplementation((operation: string) => {
    const result =
      operation === 'get_external_lifecycle_app_version_v2'
        ? { data: 1, error: null }
        : operation === 'get_external_authority_maintenance_status_v1'
          ? { data: [status], error: null }
          : { data: CLEANUP_COUNTS[operation], error: null };
    return { abortSignal: vi.fn(async () => result) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CALENDAR_TOKEN_ENCRYPTION_KEY = 'test-key';
  processCalendarRevokeOutbox.mockResolvedValue(OUTBOX_SUMMARY);
  cleanupBillingMutationClaims.mockResolvedValue({
    claimsDeleted: 2,
    hasMore: false,
    providerResponsesRedacted: 3,
  });
  cleanupBillingAccountDeletionTerminalReceipts.mockResolvedValue({
    deleted: 4,
    hasMore: false,
  });
  setupRpc();
});

describe('dispatchExternalConnectionMaintenance', () => {
  it('deadlineが逼迫していてもoutboxには1 batch分の時間を必ず残す', async () => {
    // retention の取り分（RETENTION_BUDGET_MS）より短い deadline を渡す。素朴に減算すると
    // outbox は過去の deadline を受け取り、1 件も claim せずに終わる（= calendar revoke が
    // 送られない）。dispatcher 側の下限ガードがこれを防ぐ。
    const startedAt = Date.now();
    await dispatchExternalConnectionMaintenance({ deadlineAt: startedAt + 10_000 });

    const outboxCall = processCalendarRevokeOutbox.mock.calls[0]?.[0];
    expect(outboxCall?.deadlineAt).toBeGreaterThanOrEqual(startedAt + MIN_RUN_BUDGET_MS);
  });

  it('cleanup RPC が未実装の schema でも失敗させず、due を残して不完全と報告する', async () => {
    // marker（get_external_lifecycle_app_version_v2）は「その RPC 自体の不在」でしか
    // predecessor を判定しない。app が migration より先に deploy された場合、cleanup RPC は
    // PGRST202 を返すが lifecycle 分岐は predecessor 側へ落ちない。ここで失敗扱いにすると
    // cron が毎回 500 になる。
    rpc.mockImplementation((operation: string) => {
      const result =
        operation === 'get_external_lifecycle_app_version_v2'
          ? { data: 1, error: null }
          : operation === 'get_external_authority_maintenance_status_v1'
            ? { data: [{ ...STATUS, authorization_codes_due: true }], error: null }
            : operation.startsWith('cleanup_oauth_')
              ? {
                  data: null,
                  error: { code: 'PGRST202', message: 'Could not find the function' },
                }
              : { data: CLEANUP_COUNTS[operation], error: null };
      return { abortSignal: vi.fn(async () => result) };
    });

    const summary = await dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE });

    expect(summary.schemaUnavailable).toBe(true);
    expect(summary.complete).toBe(false);
    expect(summary.retention.due.authorizationCodes).toBe(true);
    // 未実装分は 0 件として記録する（例外にしない）。
    expect(summary.retention.oauthAuthorizationCodesDeleted).toBe(0);
    expect(summary.retention.oauthConnectionsDeleted).toBe(0);
    // 実在する cleanup は通常どおり実行される。
    expect(summary.retention.mcpMutationReceiptsDeleted).toBe(
      CLEANUP_COUNTS.cleanup_mcp_mutation_receipts_v1,
    );
  });

  it('outbox後に全retention cleanupとaggregate statusを実行する', async () => {
    const sequence: string[] = [];
    processCalendarRevokeOutbox.mockImplementation(async () => {
      sequence.push('outbox');
      return OUTBOX_SUMMARY;
    });
    cleanupBillingMutationClaims.mockImplementation(async () => {
      sequence.push('cleanup_billing_mutation_claims_v2');
      return { claimsDeleted: 2, hasMore: false, providerResponsesRedacted: 3 };
    });
    cleanupBillingAccountDeletionTerminalReceipts.mockImplementation(async () => {
      sequence.push('cleanup_billing_account_deletion_terminal_receipts_v2');
      return { deleted: 4, hasMore: false };
    });
    rpc.mockImplementation((operation: string) => {
      sequence.push(operation);
      const result =
        operation === 'get_external_lifecycle_app_version_v2'
          ? { data: 1, error: null }
          : operation === 'get_external_authority_maintenance_status_v1'
            ? { data: [STATUS], error: null }
            : { data: CLEANUP_COUNTS[operation], error: null };
      return { abortSignal: vi.fn(async () => result) };
    });

    const summary = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });

    // outbox へ渡す deadline は 2 つの不変条件に挟まれている。数値を直書きすると
    // 「cleanup step を足したのに予算が据え置かれる」「retention の取り分を増やしたら
    // outbox が 1 batch も回せなくなる」の両方を静かに踏む（#1898 で実際に両方踏んだ）。
    const outboxCall = processCalendarRevokeOutbox.mock.calls[0]?.[0];
    // Composition Layer が env の暗号鍵を outbox へ配線しているかを見る唯一の assertion。
    // 引数型が `string | undefined` なので、落としても typecheck では捕まらない。
    expect(outboxCall?.encryptionKey).toBe('test-key');
    const retentionReservationMs = FAR_DEADLINE - (outboxCall?.deadlineAt ?? 0);
    // 本番で outbox が実際に持てる時間は route の予算から retention の取り分を引いた分。
    const outboxWindowMs = CRON_TIME_BUDGET_MS - retentionReservationMs;

    // (1) outbox は claim 前に expire RPC を 1 本走らせた上で、残り時間が 1 batch 分を
    //     割ると 0 件で break する。取り分がこれを下回ると calendar revoke request が
    //     永久に送られない。
    expect(outboxWindowMs).toBeGreaterThanOrEqual(MIN_RUN_BUDGET_MS);

    // (2) outbox の取り分 + retention の worst case が maxDuration を超えると、retention の
    //     途中で関数が kill される。step を足して worst case が伸びるとここが落ちる。
    expect(outboxWindowMs + RETENTION_WORST_CASE_MS).toBeLessThanOrEqual(CRON_MAX_DURATION_MS);

    // (3) 下限ガードが効いた時（lifecycle RPC が timeout 一杯かかった最悪ケース）でも
    //     (2) を満たす。ガードは outbox の取り分を押し上げる方向に働くため、こちらが
    //     実質の上限になる。
    expect(
      LIFECYCLE_RPC_TIMEOUT_MS + MIN_RUN_BUDGET_MS + RETENTION_WORST_CASE_MS,
    ).toBeLessThanOrEqual(CRON_MAX_DURATION_MS);
    expect(sequence).toEqual([
      'get_external_lifecycle_app_version_v2',
      'outbox',
      'cleanup_oauth_authorization_codes_v1',
      'cleanup_oauth_access_tokens_v1',
      'cleanup_oauth_refresh_tokens_v1',
      'cleanup_oauth_connections_v1',
      'cleanup_integration_security_events_v1',
      'cleanup_mcp_mutation_receipts_v1',
      'cleanup_billing_mutation_claims_v2',
      'cleanup_billing_account_deletion_terminal_receipts_v2',
      'get_external_authority_maintenance_status_v1',
    ]);
    expect(summary).toMatchObject({
      complete: false,
      outbox: {
        claimed: 4,
        revoked: 2,
        retried: 1,
        expired: 1,
        alreadyGone: 1,
        due: 3,
        total: 5,
        oldestDueAgeSeconds: 45,
        deferred: 3,
        revokeUnavailable: false,
      },
      retention: {
        oauthAuthorizationCodesDeleted: 1,
        oauthAccessTokensDeleted: 2,
        oauthRefreshTokensDeleted: 3,
        oauthConnectionsDeleted: 4,
        billingClaimsDeleted: 2,
        billingDeletionReceiptsDeleted: 4,
        billingProviderResponsesRedacted: 3,
        securityEventsDeleted: 6,
        mcpMutationReceiptsDeleted: 5,
        // STATUS.refresh_tokens_due = true なので、他の retention 種別に backlog が
        // 無くても hasMore は true になる（8 due flag を hasMore に組み込んだ回帰確認）。
        hasMore: true,
      },
    });
  });

  it('旧DBではproviderとretentionを変更せず正常終了する', async () => {
    rpc.mockReturnValue({
      abortSignal: vi.fn(async () => ({
        data: null,
        error: { code: 'PGRST202' },
      })),
    });

    await expect(
      dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE }),
    ).resolves.toMatchObject({
      complete: false,
      schemaUnavailable: true,
      outbox: { claimed: 0, total: 0 },
      retention: {
        oauthAuthorizationCodesDeleted: 0,
        oauthAccessTokensDeleted: 0,
        oauthRefreshTokensDeleted: 0,
        oauthConnectionsDeleted: 0,
        securityEventsDeleted: 0,
        hasMore: false,
      },
    });
    expect(processCalendarRevokeOutbox).not.toHaveBeenCalled();
    expect(cleanupBillingMutationClaims).not.toHaveBeenCalled();
    expect(cleanupBillingAccountDeletionTerminalReceipts).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('鍵が無効かつoutboxが残る場合だけrevokeUnavailableにする', async () => {
    processCalendarRevokeOutbox.mockResolvedValue({
      ...OUTBOX_SUMMARY,
      encryptionAvailable: false,
    });

    const withBacklog = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });
    expect(withBacklog.outbox.revokeUnavailable).toBe(true);

    setupRpc({ ...STATUS, calendar_revoke_due: 0, calendar_revoke_total: 0 });
    const withoutBacklog = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });
    expect(withoutBacklog.outbox.revokeUnavailable).toBe(false);
  });

  it('provider確認済みかつbacklogとretention dueがなければcomplete=trueにする', async () => {
    processCalendarRevokeOutbox.mockResolvedValue({
      ...CLEAN_OUTBOX,
      claimed: 1,
      alreadyGone: 1,
    });
    setupRpc(CLEAN_STATUS);

    const summary = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });

    expect(summary.complete).toBe(true);
  });

  it.each([
    ['retry', { outbox: { ...CLEAN_OUTBOX, retried: 1 }, status: CLEAN_STATUS }],
    ['expiry', { outbox: { ...CLEAN_OUTBOX, expired: 1 }, status: CLEAN_STATUS }],
    ['deadline', { outbox: { ...CLEAN_OUTBOX, deadlineReached: true }, status: CLEAN_STATUS }],
    [
      'calendar backlog',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, calendar_revoke_total: 1 } },
    ],
    [
      'authorization code retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, authorization_codes_due: true } },
    ],
    [
      'access token retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, access_tokens_due: true } },
    ],
    [
      'refresh token retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, refresh_tokens_due: true } },
    ],
    [
      'connection retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, connections_due: true } },
    ],
    [
      'mutation receipt retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, receipts_due: true } },
    ],
    [
      'security event retention',
      { outbox: CLEAN_OUTBOX, status: { ...CLEAN_STATUS, security_events_due: true } },
    ],
  ])('%sが残る時はcomplete=falseにする', async (_name, scenario) => {
    processCalendarRevokeOutbox.mockResolvedValue(scenario.outbox);
    setupRpc(scenario.status);

    const summary = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });

    expect(summary.complete).toBe(false);
  });

  it('Billing cleanup backlogが残る時はcomplete=falseにする', async () => {
    processCalendarRevokeOutbox.mockResolvedValue(CLEAN_OUTBOX);
    cleanupBillingMutationClaims.mockResolvedValue({
      claimsDeleted: 0,
      hasMore: true,
      providerResponsesRedacted: 0,
    });
    setupRpc(CLEAN_STATUS);

    await expect(
      dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE }),
    ).resolves.toMatchObject({
      complete: false,
      retention: { hasMore: true },
    });
  });

  it('outbox失敗後も全retentionとstatusを実行し、raw errorを再送出しない', async () => {
    const sensitive = 'v1.secret-ciphertext';
    processCalendarRevokeOutbox.mockRejectedValue(new Error(sensitive));

    const operation = dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });

    await expect(operation).rejects.toMatchObject({
      name: 'ExternalConnectionMaintenanceError',
      message: 'External connection maintenance failed',
    });
    await expect(operation).rejects.not.toThrow(sensitive);
    // version(1) + cleanup(6) + status(1) = 8
    expect(rpc).toHaveBeenCalledTimes(8);
  });

  it('1つのcleanup失敗でも残りのcleanupとstatusを続ける', async () => {
    rpc.mockImplementation((operation: string) => {
      const result =
        operation === 'get_external_lifecycle_app_version_v2'
          ? { data: 1, error: null }
          : operation === 'cleanup_integration_security_events_v1'
            ? { data: null, error: { message: 'database unavailable' } }
            : operation === 'get_external_authority_maintenance_status_v1'
              ? { data: [STATUS], error: null }
              : { data: CLEANUP_COUNTS[operation], error: null };
      return { abortSignal: vi.fn(async () => result) };
    });

    await expect(
      dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE }),
    ).rejects.toMatchObject({
      name: 'ExternalConnectionMaintenanceError',
      message: 'External connection maintenance failed',
    });
    // version(1) + cleanup(6、失敗した1本も含めて全部呼ばれる) + status(1) = 8
    expect(rpc).toHaveBeenCalledTimes(8);
  });

  it('ログと返却値はaggregateだけで秘密情報やIDを含まない', async () => {
    const summary = await dispatchExternalConnectionMaintenance({
      deadlineAt: FAR_DEADLINE,
    });

    const serialized = JSON.stringify({ summary, log: loggerInfo.mock.calls });
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('outbox_id');
    expect(serialized).not.toContain('lease_id');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('connection_id');
  });

  describe('calendarFinalizeStuck（#2055a）', () => {
    it('status の calendar_finalize_stuck_count をそのまま返す', async () => {
      processCalendarRevokeOutbox.mockResolvedValue(CLEAN_OUTBOX);
      setupRpc({ ...CLEAN_STATUS, calendar_finalize_stuck_count: 2 });

      const summary = await dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE });

      expect(summary.calendarFinalizeStuck).toBe(2);
      // 別 cron の backlog なので complete / hasMore には混ぜない。
      expect(summary.complete).toBe(true);
      expect(summary.retention.hasMore).toBe(false);
    });

    it('列が無い predecessor schema では 0 に fallback する', async () => {
      processCalendarRevokeOutbox.mockResolvedValue(CLEAN_OUTBOX);
      const { calendar_finalize_stuck_count: _omit, ...statusWithoutColumn } = CLEAN_STATUS;
      setupRpc(statusWithoutColumn as typeof CLEAN_STATUS);

      const summary = await dispatchExternalConnectionMaintenance({ deadlineAt: FAR_DEADLINE });

      expect(summary.calendarFinalizeStuck).toBe(0);
    });
  });
});
