import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { prepareBoundCalendarBeforeIdentityDeletion } from '@/features/external-calendar/server/account-deletion';
import {
  deleteBoundBillingAccountData,
  quiesceBoundBillingAccountData,
  recoverBillingCustomerBeforeAccountDeletion,
} from '@/features/settings/server/account-deletion';
import { deletePostHogAccountData } from '@/lib/analytics/posthog-deletion';
import type { Database } from '@/lib/database';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

const READINESS_RPC = 'get_account_deletion_readiness_v1' as const;
const BEGIN_RPC = 'begin_account_deletion_v1' as const;
const CLAIM_STEP_RPC = 'claim_account_deletion_step_v1' as const;
const COMPLETE_STEP_RPC = 'complete_account_deletion_step_v1' as const;
const BIND_CALENDAR_RPC = 'bind_calendar_account_deletion_v1' as const;
const BIND_BILLING_RPC = 'bind_billing_account_deletion_v1' as const;
const SEAL_BILLING_RPC = 'seal_billing_account_deletion_v1' as const;
const SEAL_RPC = 'seal_account_deletion_v1' as const;

const DB_RPC_ATTEMPTS = 3;
const DB_RPC_TIMEOUT_MS = 4_000;
const STEP_LEASE_ATTEMPTS = 3;
const STORAGE_PAGE_LIMIT = 100;
const STORAGE_REMOVE_BATCH_SIZE = 100;
const STORAGE_BUCKETS = ['avatars', 'attachments'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RETRYABLE_DATABASE_CODES = new Set(['40P01', '55P03', '57014']);

type AccountDeletionStep = 'billing' | 'calendar' | 'storage';
type AccountDeletionDatabase = SupabaseClient<Database>;
type RpcResponse<T> = Readonly<{ data: T; error: unknown }>;

type AccountDeletionCoordinatorResult = { status: 'completed' | 'contention' };

type SourceAdapterResult = Readonly<{ status: 'completed' } | { status: 'contention' }>;

type AccountDeletionCoordinatorRuntime = Readonly<{
  billing: (input: {
    stripeCustomerId: string | null;
    userId: string;
  }) => Promise<{ providerOutcome: 'deleted' | 'not_present' }>;
  billingQuiesce: (input: { stripeCustomerId: string | null; userId: string }) => Promise<void>;
  calendar: (input: { deletionId: string; userId: string }) => Promise<SourceAdapterResult>;
  db: AccountDeletionDatabase;
  posthogDeletion: (input: { userId: string }) => Promise<void>;
  recoverBilling: (input: { userId: string }) => Promise<SourceAdapterResult>;
  storage: (input: { userId: string }) => Promise<void>;
}>;

type StorageObject = Readonly<{
  metadata?: Record<string, unknown> | null;
  name: string;
}>;

class AccountDeletionCoordinatorError extends Error {
  readonly code: string;
  readonly databaseCode: string | null;

  constructor(operation: string, databaseCode: string | null, options?: ErrorOptions) {
    super('Account deletion coordination failed', options);
    this.name = 'AccountDeletionCoordinatorError';
    this.code = `ACCOUNT_DELETION_COORDINATOR_${operation.toUpperCase()}_FAILED`;
    this.databaseCode = databaseCode;
  }
}

function coordinatorFailure(
  operation: string,
  cause?: unknown,
  databaseCode: string | null = null,
): AccountDeletionCoordinatorError {
  return new AccountDeletionCoordinatorError(
    operation,
    databaseCode,
    cause === undefined ? undefined : { cause },
  );
}

function readDatabaseCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function isCoordinatorContention(error: unknown): boolean {
  return (
    error instanceof AccountDeletionCoordinatorError &&
    (error.code === 'ACCOUNT_DELETION_COORDINATOR_CONTENTION_FAILED' ||
      error.databaseCode === 'AD019' ||
      (error.databaseCode !== null && RETRYABLE_DATABASE_CODES.has(error.databaseCode)))
  );
}

async function callRpc<T>(
  operation: string,
  request: () => PromiseLike<RpcResponse<T>>,
): Promise<T> {
  let lastCause: unknown;
  let lastDatabaseCode: string | null = null;

  for (let attempt = 1; attempt <= DB_RPC_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await request();
      if (!error) return data;

      lastCause = error;
      lastDatabaseCode = readDatabaseCode(error);
      if (lastDatabaseCode !== null && RETRYABLE_DATABASE_CODES.has(lastDatabaseCode)) continue;
      throw coordinatorFailure(operation, error, lastDatabaseCode);
    } catch (error) {
      if (error instanceof AccountDeletionCoordinatorError) throw error;
      lastCause = error;
      lastDatabaseCode = readDatabaseCode(error);
    }
  }

  if (lastDatabaseCode !== null && RETRYABLE_DATABASE_CODES.has(lastDatabaseCode)) {
    throw coordinatorFailure('contention', lastCause, lastDatabaseCode);
  }
  throw coordinatorFailure(operation, lastCause, lastDatabaseCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readSingleRow(rows: unknown, operation: string): Record<string, unknown> {
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw coordinatorFailure(`${operation}_result`);
  }
  return rows[0];
}

function readReadiness(rows: unknown): {
  activated: boolean;
  activeOperations: number;
} {
  const row = readSingleRow(rows, 'readiness');
  if (
    typeof row.activated !== 'boolean' ||
    typeof row.active_operations !== 'number' ||
    !Number.isSafeInteger(row.active_operations) ||
    row.active_operations < 0
  ) {
    throw coordinatorFailure('readiness_result');
  }
  return {
    activated: row.activated,
    activeOperations: row.active_operations,
  };
}

function readDeletionId(rows: unknown): string {
  const row = readSingleRow(rows, 'begin');
  if (
    typeof row.deletion_id !== 'string' ||
    !UUID_PATTERN.test(row.deletion_id) ||
    !['pending', 'in_progress', 'completed'].includes(String(row.calendar_state)) ||
    !['pending', 'in_progress', 'completed'].includes(String(row.storage_state)) ||
    !['pending', 'in_progress', 'completed'].includes(String(row.billing_state))
  ) {
    throw coordinatorFailure('begin_result');
  }
  return row.deletion_id;
}

function readClaim(
  rows: unknown,
): { result: 'completed' } | { leaseId: string; result: 'claimed' } {
  const row = readSingleRow(rows, 'claim');
  if (row.result === 'completed') return { result: 'completed' };
  if (
    row.result !== 'claimed' ||
    typeof row.lease_id !== 'string' ||
    !UUID_PATTERN.test(row.lease_id) ||
    typeof row.lease_expires_at !== 'string' ||
    !Number.isFinite(Date.parse(row.lease_expires_at))
  ) {
    throw coordinatorFailure('claim_result');
  }
  return { leaseId: row.lease_id, result: 'claimed' };
}

function readCalendarBinding(rows: unknown): {
  calendarDeletionId: string;
  calendarRequired: boolean;
} {
  const row = readSingleRow(rows, 'calendar_binding');
  if (
    typeof row.calendar_deletion_id !== 'string' ||
    !UUID_PATTERN.test(row.calendar_deletion_id) ||
    typeof row.calendar_required !== 'boolean'
  ) {
    throw coordinatorFailure('calendar_binding_result');
  }
  return {
    calendarDeletionId: row.calendar_deletion_id,
    calendarRequired: row.calendar_required,
  };
}

function readBillingBinding(rows: unknown): {
  bindingState: 'preparing' | 'ready';
  stripeCustomerId: string | null;
} {
  const row = readSingleRow(rows, 'billing_binding');
  if (
    (row.binding_state !== 'preparing' && row.binding_state !== 'ready') ||
    (row.stripe_customer_id !== null && typeof row.stripe_customer_id !== 'string')
  ) {
    throw coordinatorFailure('billing_binding_result');
  }
  return {
    bindingState: row.binding_state,
    stripeCustomerId: row.stripe_customer_id as string | null,
  };
}

function assertTrue(value: unknown, operation: string): void {
  if (value !== true) throw coordinatorFailure(`${operation}_result`);
}

async function runStep(
  runtime: AccountDeletionCoordinatorRuntime,
  input: {
    deletionId: string;
    step: AccountDeletionStep;
    userId: string;
    work: () => Promise<void>;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= STEP_LEASE_ATTEMPTS; attempt += 1) {
    const claimedRows = await callRpc('claim', () =>
      runtime.db
        .rpc(CLAIM_STEP_RPC, {
          p_deletion_id: input.deletionId,
          p_step: input.step,
          p_user_id: input.userId,
        })
        .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
    );
    const claim = readClaim(claimedRows);
    if (claim.result === 'completed') return;

    await input.work();

    try {
      const completed = await callRpc('complete', () =>
        runtime.db
          .rpc(COMPLETE_STEP_RPC, {
            p_deletion_id: input.deletionId,
            p_lease_id: claim.leaseId,
            p_step: input.step,
            p_user_id: input.userId,
          })
          .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
      );
      assertTrue(completed, 'complete');
      return;
    } catch (error) {
      if (error instanceof AccountDeletionCoordinatorError && error.databaseCode === 'AD019') {
        continue;
      }
      throw error;
    }
  }

  throw coordinatorFailure('contention');
}

function readStorageObjects(data: StorageObject[] | null): StorageObject[] {
  if (data === null) throw coordinatorFailure('storage_inventory');

  for (const item of data) {
    if (
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      item.name === '.' ||
      item.name === '..' ||
      item.name.includes('/')
    ) {
      throw coordinatorFailure('storage_inventory');
    }
  }
  return data;
}

async function listStorageFiles(
  db: AccountDeletionDatabase,
  bucket: (typeof STORAGE_BUCKETS)[number],
  userId: string,
): Promise<string[]> {
  const pendingPrefixes = [userId];
  const files = new Set<string>();

  while (pendingPrefixes.length > 0) {
    const prefix = pendingPrefixes.shift();
    if (prefix === undefined) throw coordinatorFailure('storage_inventory');

    for (let offset = 0; ; offset += STORAGE_PAGE_LIMIT) {
      const { data, error } = await db.storage.from(bucket).list(prefix, {
        limit: STORAGE_PAGE_LIMIT,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw coordinatorFailure('storage_list', error);

      const items = readStorageObjects(data);
      for (const item of items) {
        const path = `${prefix}/${item.name}`;
        if (item.metadata === null) pendingPrefixes.push(path);
        else files.add(path);
      }

      if (items.length < STORAGE_PAGE_LIMIT) break;
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function deleteAccountStorage(
  db: AccountDeletionDatabase,
  input: { userId: string },
): Promise<void> {
  if (!UUID_PATTERN.test(input.userId)) throw coordinatorFailure('storage_user_identity');

  for (const bucket of STORAGE_BUCKETS) {
    const files = await listStorageFiles(db, bucket, input.userId);
    for (let offset = 0; offset < files.length; offset += STORAGE_REMOVE_BATCH_SIZE) {
      const batch = files.slice(offset, offset + STORAGE_REMOVE_BATCH_SIZE);
      const { error } = await db.storage.from(bucket).remove(batch);
      if (error) throw coordinatorFailure('storage_remove', error);
    }

    const remaining = await listStorageFiles(db, bucket, input.userId);
    if (remaining.length > 0) throw coordinatorFailure('storage_verification');
  }
}

export function createAccountDeletionCoordinator(runtime: AccountDeletionCoordinatorRuntime) {
  return {
    async beforeIdentityDeletion(input: {
      userId: string;
    }): Promise<AccountDeletionCoordinatorResult> {
      const readinessRows = await callRpc('readiness', () =>
        runtime.db.rpc(READINESS_RPC).abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
      );
      const readiness = readReadiness(readinessRows);
      if (!readiness.activated) {
        if (readiness.activeOperations > 0) {
          throw coordinatorFailure('inactive_with_operations');
        }
        throw coordinatorFailure('gate_inactive');
      }

      try {
        let beginRows: unknown;
        try {
          beginRows = await callRpc('begin', () =>
            runtime.db
              .rpc(BEGIN_RPC, { p_user_id: input.userId })
              .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
          );
        } catch (error) {
          if (
            !(error instanceof AccountDeletionCoordinatorError) ||
            error.databaseCode !== 'AD019'
          ) {
            throw error;
          }

          const recoveryResult = await runtime.recoverBilling(input);
          if (recoveryResult.status === 'contention') return recoveryResult;
          beginRows = await callRpc('begin', () =>
            runtime.db
              .rpc(BEGIN_RPC, { p_user_id: input.userId })
              .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
          );
        }
        const deletionId = readDeletionId(beginRows);

        const billingBindingRows = await callRpc('bind_billing', () =>
          runtime.db
            .rpc(BIND_BILLING_RPC, {
              p_generic_deletion_id: deletionId,
              p_user_id: input.userId,
            })
            .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
        );
        const billingBinding = readBillingBinding(billingBindingRows);
        if (billingBinding.bindingState === 'preparing') {
          await runtime.billingQuiesce({
            stripeCustomerId: billingBinding.stripeCustomerId,
            userId: input.userId,
          });
        }

        await runStep(runtime, {
          deletionId,
          step: 'calendar',
          userId: input.userId,
          work: async () => {
            const bindingRows = await callRpc('bind_calendar', () =>
              runtime.db
                .rpc(BIND_CALENDAR_RPC, {
                  p_generic_deletion_id: deletionId,
                  p_user_id: input.userId,
                })
                .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
            );
            const binding = readCalendarBinding(bindingRows);
            if (!binding.calendarRequired) return;

            const calendarResult = await runtime.calendar({
              deletionId: binding.calendarDeletionId,
              userId: input.userId,
            });
            if (calendarResult.status === 'contention') {
              throw coordinatorFailure('contention');
            }
          },
        });

        await runStep(runtime, {
          deletionId,
          step: 'storage',
          userId: input.userId,
          work: async () => {
            await runtime.storage(input);
            await runtime.posthogDeletion(input);
          },
        });

        await runStep(runtime, {
          deletionId,
          step: 'billing',
          userId: input.userId,
          work: async () => {
            const providerOutcome =
              billingBinding.bindingState === 'ready'
                ? billingBinding.stripeCustomerId === null
                  ? 'not_present'
                  : 'deleted'
                : (
                    await runtime.billing({
                      stripeCustomerId: billingBinding.stripeCustomerId,
                      userId: input.userId,
                    })
                  ).providerOutcome;

            const sealed = await callRpc('seal_billing', () =>
              runtime.db
                .rpc(SEAL_BILLING_RPC, {
                  p_generic_deletion_id: deletionId,
                  p_provider_outcome: providerOutcome,
                  p_user_id: input.userId,
                })
                .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
            );
            assertTrue(sealed, 'seal_billing');
          },
        });

        const sealed = await callRpc('seal', () =>
          runtime.db
            .rpc(SEAL_RPC, {
              p_deletion_id: deletionId,
              p_user_id: input.userId,
            })
            .abortSignal(AbortSignal.timeout(DB_RPC_TIMEOUT_MS)),
        );
        assertTrue(sealed, 'seal');
        return { status: 'completed' };
      } catch (error) {
        if (isCoordinatorContention(error)) return { status: 'contention' };
        throw error;
      }
    },
  };
}

export async function prepareAccountDeletionBeforeIdentityDeletion(input: {
  userId: string;
}): Promise<AccountDeletionCoordinatorResult> {
  const db = createServiceRoleClient();
  return createAccountDeletionCoordinator({
    billing: deleteBoundBillingAccountData,
    billingQuiesce: quiesceBoundBillingAccountData,
    calendar: prepareBoundCalendarBeforeIdentityDeletion,
    db,
    posthogDeletion: deletePostHogAccountData,
    recoverBilling: (billingInput) => recoverBillingCustomerBeforeAccountDeletion(db, billingInput),
    storage: (storageInput) => deleteAccountStorage(db, storageInput),
  }).beforeIdentityDeletion(input);
}
