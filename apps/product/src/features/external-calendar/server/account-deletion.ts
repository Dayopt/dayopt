import 'server-only';

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import type { Database } from '@/lib/database';
import { captureUnexpectedError } from '@/lib/sentry';

import {
  resolveGoogleCalendarAuthorityIdentity,
  type GoogleCalendarAuthorityIdentity,
} from './authority-config';
import { googleCalendarAdapter } from './providers/google';
import type { CalendarProviderAdapter } from './providers/types';
import { decryptToken } from './token-crypto';

const ABANDON_REVOKE_RPC = 'abandon_calendar_account_delete_revoke_v1' as const;
const BEGIN_DELETION_RPC = 'begin_calendar_account_deletion_v1' as const;
const DELETE_ALL_DATA_RPC = 'delete_all_user_data_command_v5' as const;
const FINALIZE_REVOKE_RPC = 'finalize_calendar_account_delete_revoke_v1' as const;
const PREPARE_REVOKE_RPC = 'prepare_calendar_account_delete_revoke_v1' as const;
const PREPARE_USER_DATA_PURGE_RPC = 'prepare_user_data_purge_v1' as const;
const READINESS_RPC = 'get_calendar_authority_readiness_v1' as const;
const SEAL_DELETION_RPC = 'seal_calendar_account_deletion_v1' as const;
const START_REVOKE_RPC = 'start_calendar_account_delete_provider_attempt_v1' as const;

const DB_RPC_ATTEMPTS = 3;
const DB_RPC_TIMEOUT_MS = 4_000;
const ITEM_PREPARATION_ATTEMPTS = 3;
const PROVIDER_SETTLEMENT_BUDGET_MS = 19_000;

const PREPARE_TERMINAL_RESULTS = new Set([
  'expiry_guarded',
  'expired',
  'missing',
  'not_attempted',
  'revoke_guarded',
  'revoked',
]);

const DURABLE_REVOKE_RESULTS = new Set(['expiry_guarded', 'expired', 'revoke_guarded', 'revoked']);

type CalendarAccountDeletionDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Pick<
      Database['public']['Functions'],
      | typeof ABANDON_REVOKE_RPC
      | typeof BEGIN_DELETION_RPC
      | typeof DELETE_ALL_DATA_RPC
      | typeof FINALIZE_REVOKE_RPC
      | typeof PREPARE_REVOKE_RPC
      | typeof PREPARE_USER_DATA_PURGE_RPC
      | typeof READINESS_RPC
      | typeof SEAL_DELETION_RPC
      | typeof START_REVOKE_RPC
    >;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type CalendarAccountDeletionClient = SupabaseClient<CalendarAccountDeletionDatabase>;

type RpcResponse<T> = {
  data: T;
  error: unknown;
};

type DeletionInventoryItem = {
  itemId: string;
  itemKind: 'connection' | 'outbox';
};

type PreparedRevoke = {
  attemptDeadlineAt: string;
  leaseId: string;
  operationId: string;
  refreshTokenEnc: string;
};

type CalendarAccountDeletionRuntime = Readonly<{
  db: CalendarAccountDeletionClient;
  encryptionKey: string;
  generateId: () => string;
  identity: GoogleCalendarAuthorityIdentity;
  now: () => number;
  provider: Pick<CalendarProviderAdapter, 'revoke'>;
}>;

type AccountDeletionAdapterResult = {
  status: 'completed' | 'contention';
};

type UserDataPurgePreflightResult =
  | {
      expectedGeneration: number;
      operationId: string;
      status: 'ready';
    }
  | { status: 'contention' };

export class CalendarAccountDeletionError extends Error {
  readonly code: string;

  constructor(operation: string) {
    super('Calendar account deletion preparation failed');
    this.name = 'CalendarAccountDeletionError';
    this.code = `CALENDAR_ACCOUNT_DELETION_${operation.toUpperCase()}_FAILED`;
  }
}

function deletionFailure(operation: string): CalendarAccountDeletionError {
  return new CalendarAccountDeletionError(operation);
}

function isRetryableAdapterFailure(error: unknown): boolean {
  return (
    error instanceof CalendarAccountDeletionError &&
    [
      'CALENDAR_ACCOUNT_DELETION_CONTENTION_FAILED',
      'CALENDAR_ACCOUNT_DELETION_PREPARE_IN_FLIGHT_FAILED',
      'CALENDAR_ACCOUNT_DELETION_START_IN_FLIGHT_FAILED',
    ].includes(error.code)
  );
}

/**
 * factory 側の床。個別 query の `.abortSignal(DB_RPC_TIMEOUT_MS)` はこれより短い
 * 上書きで、**両方あってよい**。付け忘れた query が無制限にならないようにする。
 */
const CLIENT_FLOOR_TIMEOUT_MS = 15_000;

function createCalendarAccountDeletionClient(): CalendarAccountDeletionClient {
  return createClient<CalendarAccountDeletionDatabase>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            signal: options?.signal ?? AbortSignal.timeout(CLIENT_FLOOR_TIMEOUT_MS),
          }),
      },
    },
  );
}

function isRetryableContention(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return (
    error.code === '40P01' ||
    error.code === '55P03' ||
    error.code === '57014' ||
    error.code === 'CA019'
  );
}

async function callRpc<T>(
  operation: string,
  request: () => PromiseLike<RpcResponse<T>>,
): Promise<T> {
  let contentionFailure = false;

  for (let attempt = 1; attempt <= DB_RPC_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await request();
      if (!error) return data;
      if (isRetryableContention(error)) {
        contentionFailure = true;
        continue;
      }
      throw deletionFailure(operation);
    } catch (error) {
      if (error instanceof CalendarAccountDeletionError) throw error;
      // commit後のresponse lossとrollbackを区別できない。全RPCは同じ引数でreplay-safe。
    }
  }

  if (contentionFailure) throw deletionFailure('contention');
  throw deletionFailure(operation);
}

function readCanonicalInventory(
  rows: Array<{ deletion_id: string; item_id: string; item_kind: string }> | null,
): { deletionId: string; items: DeletionInventoryItem[] } {
  if (!Array.isArray(rows) || rows.length === 0) throw deletionFailure('begin_result');

  const deletionId =
    typeof rows[0]?.deletion_id === 'string' && rows[0].deletion_id.length > 0
      ? rows[0].deletion_id
      : null;
  if (deletionId === null) throw deletionFailure('begin_result');

  const items: DeletionInventoryItem[] = [];
  const itemKeys = new Set<string>();
  let sawNone = false;

  for (const row of rows) {
    if (row.deletion_id !== deletionId) throw deletionFailure('begin_result');

    if (row.item_kind === 'none') {
      sawNone = true;
      continue;
    }

    if (
      (row.item_kind !== 'connection' && row.item_kind !== 'outbox') ||
      typeof row.item_id !== 'string' ||
      row.item_id.length === 0
    ) {
      throw deletionFailure('begin_result');
    }

    const itemKey = `${row.item_kind}:${row.item_id}`;
    if (itemKeys.has(itemKey)) throw deletionFailure('begin_result');
    itemKeys.add(itemKey);
    items.push({ itemId: row.item_id, itemKind: row.item_kind });
  }

  if (sawNone && items.length > 0) throw deletionFailure('begin_result');
  return { deletionId, items };
}

function readPreparedRevoke(
  rows: Array<{
    attempt_deadline_at: string;
    lease_id: string;
    operation_id: string;
    refresh_token_enc: string;
    result: string;
  }> | null,
):
  | { outcome: 'terminal' }
  | { outcome: 'prepared'; prepared: PreparedRevoke }
  | { outcome: 'retry_blocked' } {
  if (!Array.isArray(rows) || rows.length !== 1) throw deletionFailure('prepare_result');
  const row = rows[0];
  if (row === undefined || typeof row.result !== 'string') {
    throw deletionFailure('prepare_result');
  }

  if (PREPARE_TERMINAL_RESULTS.has(row.result)) return { outcome: 'terminal' };
  if (row.result === 'in_flight') return { outcome: 'retry_blocked' };
  if (row.result !== 'prepared') throw deletionFailure('prepare_result');

  if (
    typeof row.operation_id !== 'string' ||
    row.operation_id.length === 0 ||
    typeof row.lease_id !== 'string' ||
    row.lease_id.length === 0 ||
    typeof row.refresh_token_enc !== 'string' ||
    row.refresh_token_enc.length === 0 ||
    typeof row.attempt_deadline_at !== 'string' ||
    !Number.isFinite(Date.parse(row.attempt_deadline_at))
  ) {
    throw deletionFailure('prepare_result');
  }

  return {
    outcome: 'prepared',
    prepared: {
      attemptDeadlineAt: row.attempt_deadline_at,
      leaseId: row.lease_id,
      operationId: row.operation_id,
      refreshTokenEnc: row.refresh_token_enc,
    },
  };
}

function assertTerminalRevokeResult(result: string, operation: string): void {
  if (!DURABLE_REVOKE_RESULTS.has(result)) throw deletionFailure(operation);
}

async function assertDatabaseIdentity(runtime: CalendarAccountDeletionRuntime): Promise<void> {
  const rows = await callRpc('readiness', () =>
    runtime.db
      .rpc(READINESS_RPC, {
        p_project_key: runtime.identity.projectKey,
        p_oauth_client_id: runtime.identity.oauthClientId,
      })
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
  );
  const readiness = rows?.[0];

  if (
    readiness === undefined ||
    readiness.activated !== true ||
    readiness.oauth_client_id !== runtime.identity.oauthClientId ||
    typeof readiness.pending_operations !== 'number' ||
    typeof readiness.unbound_connections !== 'number' ||
    typeof readiness.unbound_outbox !== 'number'
  ) {
    throw deletionFailure('readiness_result');
  }
}

async function finalizeRevoke(
  runtime: CalendarAccountDeletionRuntime,
  input: {
    deletionId: string;
    leaseId: string;
    operationId: string;
    outcome: 'confirmed' | 'not_started' | 'unconfirmed';
    userId: string;
  },
): Promise<string> {
  const result = await callRpc('finalize', () =>
    runtime.db
      .rpc(FINALIZE_REVOKE_RPC, {
        p_deletion_id: input.deletionId,
        p_project_key: runtime.identity.projectKey,
        p_user_id: input.userId,
        p_operation_id: input.operationId,
        p_lease_id: input.leaseId,
        p_outcome: input.outcome,
      })
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
  );
  if (typeof result !== 'string') throw deletionFailure('finalize_result');
  return result;
}

async function processInventoryItem(
  runtime: CalendarAccountDeletionRuntime,
  input: {
    deletionId: string;
    item: DeletionInventoryItem;
    userId: string;
  },
): Promise<void> {
  const requestedOperationId = runtime.generateId();

  for (
    let preparationAttempt = 1;
    preparationAttempt <= ITEM_PREPARATION_ATTEMPTS;
    preparationAttempt += 1
  ) {
    const preparedRows = await callRpc('prepare', () =>
      runtime.db
        .rpc(PREPARE_REVOKE_RPC, {
          p_deletion_id: input.deletionId,
          p_operation_id: requestedOperationId,
          p_project_key: runtime.identity.projectKey,
          p_user_id: input.userId,
          p_item_kind: input.item.itemKind,
          p_item_id: input.item.itemId,
        })
        .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
    );
    const preparation = readPreparedRevoke(preparedRows);

    if (preparation.outcome === 'terminal') return;
    if (preparation.outcome === 'retry_blocked') throw deletionFailure('prepare_in_flight');

    const { prepared } = preparation;
    if (Date.parse(prepared.attemptDeadlineAt) - runtime.now() < PROVIDER_SETTLEMENT_BUDGET_MS) {
      const result = await finalizeRevoke(runtime, {
        deletionId: input.deletionId,
        userId: input.userId,
        operationId: prepared.operationId,
        leaseId: prepared.leaseId,
        outcome: 'not_started',
      });

      if (result === 'retried') continue;
      assertTerminalRevokeResult(result, 'deadline_finalization');
      return;
    }

    let refreshToken: string;
    try {
      refreshToken = decryptToken(prepared.refreshTokenEnc, runtime.encryptionKey);
    } catch {
      captureUnexpectedError(new Error('Calendar account deletion token decryption failed'), {
        feature: 'external_calendar',
        operation: 'prepare_account_deletion',
      });

      const result = await callRpc('abandon', () =>
        runtime.db
          .rpc(ABANDON_REVOKE_RPC, {
            p_deletion_id: input.deletionId,
            p_project_key: runtime.identity.projectKey,
            p_user_id: input.userId,
            p_operation_id: prepared.operationId,
            p_lease_id: prepared.leaseId,
            p_reason: 'decrypt_failed',
          })
          .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
      );

      if (result !== 'not_attempted') throw deletionFailure('abandon_result');
      return;
    }

    const startResult = await callRpc('start', () =>
      runtime.db
        .rpc(START_REVOKE_RPC, {
          p_deletion_id: input.deletionId,
          p_project_key: runtime.identity.projectKey,
          p_user_id: input.userId,
          p_operation_id: prepared.operationId,
          p_lease_id: prepared.leaseId,
        })
        .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
    );

    if (startResult === 'already_started') throw deletionFailure('start_in_flight');
    if (typeof startResult !== 'string') throw deletionFailure('start_result');
    if (DURABLE_REVOKE_RESULTS.has(startResult)) return;
    if (startResult !== 'started') throw deletionFailure('start_result');

    let outcome: 'confirmed' | 'unconfirmed' = 'unconfirmed';
    try {
      if (await runtime.provider.revoke(refreshToken)) outcome = 'confirmed';
    } catch {
      captureUnexpectedError(new Error('Calendar account deletion provider outcome is unknown'), {
        feature: 'external_calendar',
        operation: 'revoke_account_deletion_token',
      });
    }

    const finalizeResult = await finalizeRevoke(runtime, {
      deletionId: input.deletionId,
      userId: input.userId,
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      outcome,
    });
    assertTerminalRevokeResult(finalizeResult, 'finalize_result');
    return;
  }

  throw deletionFailure('prepare_attempts');
}

async function prepareIdentityDeletion(
  runtime: CalendarAccountDeletionRuntime,
  input: {
    deletionId: string;
    requireExactDeletionId: boolean;
    userId: string;
  },
): Promise<void> {
  await assertDatabaseIdentity(runtime);

  const inventoryRows = await callRpc('begin', () =>
    runtime.db
      .rpc(BEGIN_DELETION_RPC, {
        p_deletion_id: input.deletionId,
        p_project_key: runtime.identity.projectKey,
        p_user_id: input.userId,
      })
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
  );
  const inventory = readCanonicalInventory(inventoryRows);
  if (input.requireExactDeletionId && inventory.deletionId !== input.deletionId) {
    throw deletionFailure('bound_identity');
  }

  for (const item of inventory.items) {
    await processInventoryItem(runtime, {
      deletionId: inventory.deletionId,
      item,
      userId: input.userId,
    });
  }

  const sealed = await callRpc('seal', () =>
    runtime.db
      .rpc(SEAL_DELETION_RPC, {
        p_deletion_id: inventory.deletionId,
        p_project_key: runtime.identity.projectKey,
        p_user_id: input.userId,
      })
      .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
  );
  if (sealed !== true) throw deletionFailure('seal_result');
}

export function createCalendarAccountDeletionService(runtime: CalendarAccountDeletionRuntime) {
  return {
    async beforeIdentityDeletion(input: { userId: string }): Promise<void> {
      return prepareIdentityDeletion(runtime, {
        deletionId: runtime.generateId(),
        requireExactDeletionId: false,
        userId: input.userId,
      });
    },

    async beforeBoundIdentityDeletion(input: {
      deletionId: string;
      userId: string;
    }): Promise<void> {
      return prepareIdentityDeletion(runtime, {
        ...input,
        requireExactDeletionId: true,
      });
    },

    async prepareDeleteAllData(input: {
      userId: string;
    }): Promise<{ expectedGeneration: number; operationId: string }> {
      await assertDatabaseIdentity(runtime);

      const rows = await callRpc('prepare_delete_all_data', () =>
        runtime.db
          .rpc(PREPARE_USER_DATA_PURGE_RPC, {
            p_user_id: input.userId,
          })
          .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
      );
      const preflight = rows?.[0];

      if (
        !Array.isArray(rows) ||
        rows.length !== 1 ||
        preflight === undefined ||
        typeof preflight.operation_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          preflight.operation_id,
        ) ||
        !Number.isSafeInteger(preflight.expected_generation) ||
        preflight.expected_generation < 0
      ) {
        throw deletionFailure('purge_preflight_result');
      }

      return {
        expectedGeneration: preflight.expected_generation,
        operationId: preflight.operation_id,
      };
    },

    async deleteAllData(input: {
      expectedGeneration: number;
      operationId: string;
      userId: string;
    }): Promise<void> {
      await assertDatabaseIdentity(runtime);

      const deleted = await callRpc('delete_all_data', () =>
        runtime.db
          .rpc(DELETE_ALL_DATA_RPC, {
            p_expected_generation: input.expectedGeneration,
            p_operation_id: input.operationId,
            p_project_key: runtime.identity.projectKey,
            p_user_id: input.userId,
          })
          .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
      );
      if (deleted !== true) throw deletionFailure('delete_all_data_result');
    },
  };
}

type CalendarAccountDeletionService = Pick<
  ReturnType<typeof createCalendarAccountDeletionService>,
  | 'beforeBoundIdentityDeletion'
  | 'beforeIdentityDeletion'
  | 'deleteAllData'
  | 'prepareDeleteAllData'
>;

export function createCalendarAccountDeletionAdapter(service: CalendarAccountDeletionService) {
  async function run(operation: () => Promise<void>): Promise<AccountDeletionAdapterResult> {
    try {
      await operation();
      return { status: 'completed' };
    } catch (error) {
      if (isRetryableAdapterFailure(error)) return { status: 'contention' };
      throw error;
    }
  }

  return {
    beforeBoundIdentityDeletion(input: {
      deletionId: string;
      userId: string;
    }): Promise<AccountDeletionAdapterResult> {
      return run(() => service.beforeBoundIdentityDeletion(input));
    },
    beforeIdentityDeletion(input: { userId: string }): Promise<AccountDeletionAdapterResult> {
      return run(() => service.beforeIdentityDeletion(input));
    },
    async prepareDeleteAllData(input: { userId: string }): Promise<UserDataPurgePreflightResult> {
      try {
        const preflight = await service.prepareDeleteAllData(input);
        return { ...preflight, status: 'ready' };
      } catch (error) {
        if (isRetryableAdapterFailure(error)) return { status: 'contention' };
        throw error;
      }
    },
    deleteAllData(input: {
      expectedGeneration: number;
      operationId: string;
      userId: string;
    }): Promise<AccountDeletionAdapterResult> {
      return run(() => service.deleteAllData(input));
    },
  };
}

function createConfiguredCalendarAccountDeletionService() {
  const identity = resolveGoogleCalendarAuthorityIdentity();
  if (identity === null) throw deletionFailure('identity');

  return createCalendarAccountDeletionService({
    db: createCalendarAccountDeletionClient(),
    encryptionKey: env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? '',
    generateId: randomUUID,
    identity,
    now: Date.now,
    provider: googleCalendarAdapter,
  });
}

export async function prepareBoundCalendarBeforeIdentityDeletion(input: {
  deletionId: string;
  userId: string;
}): Promise<AccountDeletionAdapterResult> {
  return createCalendarAccountDeletionAdapter(
    createConfiguredCalendarAccountDeletionService(),
  ).beforeBoundIdentityDeletion(input);
}
