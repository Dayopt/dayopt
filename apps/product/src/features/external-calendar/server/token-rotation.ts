import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';
import { databaseTables, type Database } from '@/lib/database';
import { isPredecessorMissingFunction } from '@/lib/database/external-lifecycle-version';
import { captureUnexpectedError } from '@/lib/sentry';

import type { CalendarProviderAdapter } from './providers/types';
import { encryptToken } from './token-crypto';

const TOKEN_RPC_TIMEOUT_MS = 4_000;
const TOKEN_RPC_ATTEMPTS = 3;
const ROTATION_RPC_NAME = 'rotate_or_enqueue_calendar_refresh_token_command_v2' as const;
const MARK_REAUTH_RPC_NAME = 'mark_calendar_connection_reauth_command_v2' as const;
const PREPARE_RECOVERY_RPC_NAME = 'prepare_calendar_token_rotation_recovery_command_v1' as const;
const LIFECYCLE_VERSION_RPC_NAME = 'get_external_lifecycle_app_version_v2' as const;

const DEFINITIVE_ROLLBACK_CODES = new Set([
  '22023',
  '42501',
  'CA001',
  'CA002',
  'CA003',
  'CA004',
  'DG003',
  'DT001',
]);

type CalendarTokenRotationDatabase = {
  public: {
    Tables: Pick<Database['public']['Tables'], 'calendar_connections'>;
    Views: Record<string, never>;
    Functions: Pick<
      Database['public']['Functions'],
      | typeof LIFECYCLE_VERSION_RPC_NAME
      | typeof MARK_REAUTH_RPC_NAME
      | typeof PREPARE_RECOVERY_RPC_NAME
      | typeof ROTATION_RPC_NAME
    >;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type CalendarTokenRotationClient = SupabaseClient<CalendarTokenRotationDatabase>;

type RotationPersistenceOutcome = 'updated' | 'enqueued' | 'rejected' | 'unresolved';
type RotationRecoveryOutcome = 'marked' | 'missing' | 'unresolved';
type CalendarConnectionReauthOutcome = 'marked' | 'missing' | 'superseded' | 'unresolved';
type CalendarTokenRotationOutcome =
  'updated' | 'enqueued' | 'reauth_required' | 'missing' | 'superseded' | 'unresolved';
type CalendarTokenRotationResult = {
  outcome: CalendarTokenRotationOutcome;
  /**
   * このrunでDBへ保存した新authorityを、後続provider callのinvalid_grant時だけmarkする。
   * 暗号文をcallerへ公開せず、同じoperation ID・同じ暗号文をclosure内に保持する。
   */
  markReauthIfCurrent: (() => Promise<CalendarConnectionReauthOutcome>) | null;
};

type PersistCalendarTokenRotationInput = {
  operationId: string;
  userId: string;
  connectionId: string;
  expectedGeneration: number;
  expectedRefreshTokenEnc: string;
  rotatedRefreshToken: string;
  encryptionKey: string;
  provider: Pick<CalendarProviderAdapter, 'revoke'>;
  lastSyncedAt?: string;
};

type MarkCalendarConnectionReauthInput = {
  userId: string;
  connectionId: string;
  expectedGeneration: number;
  expectedRefreshTokenEnc: string;
  lastSyncedAt?: string;
} & (
  | {
      operationId?: undefined;
      newRefreshTokenEnc?: undefined;
    }
  | {
      operationId: string;
      newRefreshTokenEnc: string;
    }
);

/**
 * factory 側の床。個別 query の `.abortSignal(TOKEN_RPC_TIMEOUT_MS)` はこれより短い
 * 上書きで、**両方あってよい**。
 *
 * 床が要るのは、`.abortSignal()` が付いていない query が実際に残っていたため
 * （legacy 分岐の `.update().maybeSingle()` と `readLegacyConnection()`）。個別に
 * 付けて回ると付け忘れが検出できないので、client 生成時に必ず効く上限を置く。
 */
const CLIENT_FLOOR_TIMEOUT_MS = 15_000;

function createCalendarTokenRotationClient(): CalendarTokenRotationClient {
  return createClient<CalendarTokenRotationDatabase>(
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

/**
 * Provider が発行した新 refresh token の所有先を確定する。
 *
 * transport timeout は commit 後のresponse欠落かもしれない。同じoperation ID・同じ暗号文で
 * 再試行し、DB側のCAS / outbox identityから結果を確定する。raw DB errorや暗号文は
 * logger / Sentryへ渡さない。
 */
export async function persistCalendarTokenRotation(
  input: PersistCalendarTokenRotationInput,
): Promise<CalendarTokenRotationResult> {
  const lifecycleVersion = await readLifecycleVersion();
  if (lifecycleVersion === 'unresolved') {
    return { outcome: 'unresolved', markReauthIfCurrent: null };
  }
  if (lifecycleVersion === 0) {
    return persistLegacyCalendarTokenRotation(input);
  }

  let newRefreshTokenEnc: string;
  try {
    // retryごとに暗号化し直すとAES-GCMのIVが変わり、同じoperationのpayloadでなくなる。
    newRefreshTokenEnc = encryptToken(input.rotatedRefreshToken, input.encryptionKey);
  } catch {
    captureUnexpectedError(new Error('calendar token rotation encryption failed'), {
      feature: 'external_calendar',
      operation: 'encrypt_rotated_refresh_token',
    });
    return await recoverCalendarTokenRotation(input);
  }

  const args = {
    p_operation_id: input.operationId,
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_generation: input.expectedGeneration,
    p_expected_refresh_token_enc: input.expectedRefreshTokenEnc,
    p_new_refresh_token_enc: newRefreshTokenEnc,
  };

  const persistenceOutcome = await callRotationPersistence(args);
  if (persistenceOutcome === 'updated') {
    return {
      outcome: 'updated',
      markReauthIfCurrent: () =>
        markCalendarConnectionReauth({
          userId: input.userId,
          connectionId: input.connectionId,
          expectedGeneration: input.expectedGeneration,
          expectedRefreshTokenEnc: input.expectedRefreshTokenEnc,
          operationId: input.operationId,
          newRefreshTokenEnc,
          ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
        }),
    };
  }
  if (persistenceOutcome === 'enqueued') {
    return { outcome: 'enqueued', markReauthIfCurrent: null };
  }

  return await recoverCalendarTokenRotation(input, newRefreshTokenEnc);
}

async function callRotationPersistence(
  args: Database['public']['Functions'][typeof ROTATION_RPC_NAME]['Args'],
): Promise<RotationPersistenceOutcome> {
  for (let attempt = 0; attempt < TOKEN_RPC_ATTEMPTS; attempt += 1) {
    try {
      const db = createCalendarTokenRotationClient();
      const { data, error } = await db
        .rpc(ROTATION_RPC_NAME, args)
        .abortSignal(AbortSignal.timeout(TOKEN_RPC_TIMEOUT_MS));

      if (!error && (data === 'updated' || data === 'enqueued')) return data;

      if (error?.code && DEFINITIVE_ROLLBACK_CODES.has(error.code)) {
        captureUnexpectedError(new Error('calendar token rotation was rejected'), {
          feature: 'external_calendar',
          operation: 'persist_rotated_refresh_token',
          source: 'supabase_rpc',
        });
        return 'rejected';
      }
    } catch {
      // response欠落とrollbackを区別できない。raw errorを保持せず同一payloadで再試行する。
    }
  }

  captureUnexpectedError(new Error('calendar token rotation outcome is unresolved'), {
    feature: 'external_calendar',
    operation: 'persist_rotated_refresh_token',
    source: 'supabase_rpc',
  });
  return 'unresolved';
}

/**
 * 観測したtoken authorityだけをreauth_requiredへ遷移する。
 *
 * response欠落後のretryは同じCAS値を使う。別rotation/reconnectが先行していれば
 * supersededを返し、その新しいauthorityを上書きしない。
 */
export async function markCalendarConnectionReauth(
  input: MarkCalendarConnectionReauthInput,
): Promise<CalendarConnectionReauthOutcome> {
  const lifecycleVersion = await readLifecycleVersion();
  if (lifecycleVersion === 'unresolved') return 'unresolved';
  if (lifecycleVersion === 0) return markLegacyCalendarConnectionReauth(input);

  const args = {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_generation: input.expectedGeneration,
    p_expected_refresh_token_enc: input.expectedRefreshTokenEnc,
    ...(input.operationId === undefined
      ? {}
      : {
          p_operation_id: input.operationId,
          p_new_refresh_token_enc: input.newRefreshTokenEnc,
        }),
    ...(input.lastSyncedAt === undefined ? {} : { p_last_synced_at: input.lastSyncedAt }),
  };

  for (let attempt = 0; attempt < TOKEN_RPC_ATTEMPTS; attempt += 1) {
    try {
      const db = createCalendarTokenRotationClient();
      const { data, error } = await db
        .rpc(MARK_REAUTH_RPC_NAME, args)
        .abortSignal(AbortSignal.timeout(TOKEN_RPC_TIMEOUT_MS));

      if (!error && (data === 'marked' || data === 'missing' || data === 'superseded')) {
        return data;
      }

      if (error?.code && DEFINITIVE_ROLLBACK_CODES.has(error.code)) {
        captureUnexpectedError(new Error('calendar connection reauthorization was rejected'), {
          feature: 'external_calendar',
          operation: 'mark_connection_reauth_required',
          source: 'supabase_rpc',
        });
        return 'unresolved';
      }
    } catch {
      // response欠落とrollbackを区別できないため、同じCAS値で再試行する。
    }
  }

  captureUnexpectedError(new Error('calendar connection reauthorization is unresolved'), {
    feature: 'external_calendar',
    operation: 'mark_connection_reauth_required',
    source: 'supabase_rpc',
  });
  return 'unresolved';
}

async function readLifecycleVersion(): Promise<0 | 1 | 'unresolved'> {
  try {
    const db = createCalendarTokenRotationClient();
    const { data, error } = await db
      .rpc(LIFECYCLE_VERSION_RPC_NAME)
      .abortSignal(AbortSignal.timeout(TOKEN_RPC_TIMEOUT_MS));

    if (error) {
      if (isPredecessorMissingFunction(error)) return 0;
      throw new Error('lifecycle marker failed');
    }
    if (data !== 1) throw new Error('lifecycle marker was inconsistent');
    return 1;
  } catch {
    captureUnexpectedError(new Error('external lifecycle schema version is unresolved'), {
      feature: 'external_calendar',
      operation: 'read_lifecycle_schema_version',
      source: 'supabase_rpc',
    });
    return 'unresolved';
  }
}

async function persistLegacyCalendarTokenRotation(
  input: PersistCalendarTokenRotationInput,
): Promise<CalendarTokenRotationResult> {
  let newRefreshTokenEnc: string;
  try {
    newRefreshTokenEnc = encryptToken(input.rotatedRefreshToken, input.encryptionKey);
  } catch {
    captureUnexpectedError(new Error('calendar token rotation encryption failed'), {
      feature: 'external_calendar',
      operation: 'encrypt_rotated_refresh_token',
    });
    const markOutcome = await markLegacyCalendarConnectionReauth({
      userId: input.userId,
      connectionId: input.connectionId,
      expectedGeneration: input.expectedGeneration,
      expectedRefreshTokenEnc: input.expectedRefreshTokenEnc,
      ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
    });
    await compensateCalendarTokenRotation(input.provider, input.rotatedRefreshToken);
    return {
      outcome:
        markOutcome === 'marked'
          ? 'reauth_required'
          : markOutcome === 'missing'
            ? 'missing'
            : markOutcome,
      markReauthIfCurrent: null,
    };
  }

  const db = createCalendarTokenRotationClient();
  for (let attempt = 0; attempt < TOKEN_RPC_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await db
        .from(databaseTables.calendarConnections)
        .update({ refresh_token_enc: newRefreshTokenEnc })
        .eq('id', input.connectionId)
        .eq('user_id', input.userId)
        .eq('refresh_token_enc', input.expectedRefreshTokenEnc)
        .select('id')
        .maybeSingle();

      if (!error && data) {
        return {
          outcome: 'updated',
          markReauthIfCurrent: () =>
            markLegacyCalendarConnectionReauth({
              userId: input.userId,
              connectionId: input.connectionId,
              expectedGeneration: input.expectedGeneration,
              expectedRefreshTokenEnc: input.expectedRefreshTokenEnc,
              operationId: input.operationId,
              newRefreshTokenEnc,
              ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
            }),
        };
      }
      if (!error) break;
    } catch {
      // The exact ciphertext is stable, so a final read can reconcile a lost update response.
    }
  }

  const current = await readLegacyConnection(input.userId, input.connectionId);
  if (current === 'unresolved') {
    return { outcome: 'unresolved', markReauthIfCurrent: null };
  }
  if (current === null) {
    await compensateCalendarTokenRotation(input.provider, input.rotatedRefreshToken);
    return { outcome: 'missing', markReauthIfCurrent: null };
  }
  if (current.refresh_token_enc === newRefreshTokenEnc) {
    return {
      outcome: 'updated',
      markReauthIfCurrent: () =>
        markLegacyCalendarConnectionReauth({
          userId: input.userId,
          connectionId: input.connectionId,
          expectedGeneration: input.expectedGeneration,
          expectedRefreshTokenEnc: input.expectedRefreshTokenEnc,
          operationId: input.operationId,
          newRefreshTokenEnc,
          ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
        }),
    };
  }
  if (current.refresh_token_enc !== input.expectedRefreshTokenEnc) {
    await compensateCalendarTokenRotation(input.provider, input.rotatedRefreshToken);
    return { outcome: 'superseded', markReauthIfCurrent: null };
  }

  const markOutcome = await markLegacyCalendarConnectionReauth({
    userId: input.userId,
    connectionId: input.connectionId,
    expectedGeneration: input.expectedGeneration,
    expectedRefreshTokenEnc: input.expectedRefreshTokenEnc,
    ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
  });
  await compensateCalendarTokenRotation(input.provider, input.rotatedRefreshToken);
  return {
    outcome:
      markOutcome === 'marked'
        ? 'reauth_required'
        : markOutcome === 'missing'
          ? 'missing'
          : markOutcome,
    markReauthIfCurrent: null,
  };
}

async function markLegacyCalendarConnectionReauth(
  input: MarkCalendarConnectionReauthInput,
): Promise<CalendarConnectionReauthOutcome> {
  const targetRefreshTokenEnc = input.newRefreshTokenEnc ?? input.expectedRefreshTokenEnc;
  const db = createCalendarTokenRotationClient();

  for (let attempt = 0; attempt < TOKEN_RPC_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await db
        .from(databaseTables.calendarConnections)
        .update({
          status: 'reauth_required',
          last_sync_error: 'reauth_required',
          ...(input.lastSyncedAt === undefined ? {} : { last_synced_at: input.lastSyncedAt }),
        })
        .eq('id', input.connectionId)
        .eq('user_id', input.userId)
        .eq('refresh_token_enc', targetRefreshTokenEnc)
        .select('id')
        .maybeSingle();

      if (!error && data) return 'marked';
      if (!error) break;
    } catch {
      // A final exact read distinguishes a committed response loss from no update.
    }
  }

  const current = await readLegacyConnection(input.userId, input.connectionId);
  if (current === 'unresolved') return 'unresolved';
  if (current === null) return 'missing';
  if (current.refresh_token_enc !== targetRefreshTokenEnc) {
    return 'superseded';
  }
  return current.status === 'reauth_required' ? 'marked' : 'unresolved';
}

async function readLegacyConnection(
  userId: string,
  connectionId: string,
): Promise<{ refresh_token_enc: string; status: string } | null | 'unresolved'> {
  try {
    const db = createCalendarTokenRotationClient();
    const { data, error } = await db
      .from(databaseTables.calendarConnections)
      .select('refresh_token_enc, status')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return 'unresolved';
    return data;
  } catch {
    return 'unresolved';
  }
}

/**
 * Provider失効より先に、DBで現authorityをfail-closeして新tokenの所有先を確定する。
 *
 * 暗号化済みならrevoke outbox workerへ委ねる。暗号化自体が失敗した時だけ、DBで
 * active rowを停止できた後に限ってplaintext tokenを直接失効する。
 */
async function recoverCalendarTokenRotation(
  input: PersistCalendarTokenRotationInput,
  newRefreshTokenEnc?: string,
): Promise<CalendarTokenRotationResult> {
  const args = {
    p_operation_id: input.operationId,
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_generation: input.expectedGeneration,
    p_expected_refresh_token_enc: input.expectedRefreshTokenEnc,
    ...(newRefreshTokenEnc === undefined ? {} : { p_new_refresh_token_enc: newRefreshTokenEnc }),
  };

  const recoveryOutcome = await callRecoveryPreparation({
    ...args,
    ...(input.lastSyncedAt === undefined ? {} : { p_last_synced_at: input.lastSyncedAt }),
  });
  if (recoveryOutcome === 'unresolved') {
    return { outcome: 'unresolved', markReauthIfCurrent: null };
  }

  if (newRefreshTokenEnc === undefined) {
    await compensateCalendarTokenRotation(input.provider, input.rotatedRefreshToken);
  }

  if (recoveryOutcome === 'marked') {
    return { outcome: 'reauth_required', markReauthIfCurrent: null };
  }
  return { outcome: 'missing', markReauthIfCurrent: null };
}

async function callRecoveryPreparation(
  args: Database['public']['Functions'][typeof PREPARE_RECOVERY_RPC_NAME]['Args'],
): Promise<RotationRecoveryOutcome> {
  for (let attempt = 0; attempt < TOKEN_RPC_ATTEMPTS; attempt += 1) {
    try {
      const db = createCalendarTokenRotationClient();
      const { data, error } = await db
        .rpc(PREPARE_RECOVERY_RPC_NAME, args)
        .abortSignal(AbortSignal.timeout(TOKEN_RPC_TIMEOUT_MS));

      if (!error && (data === 'marked' || data === 'missing')) return data;

      if (error?.code && DEFINITIVE_ROLLBACK_CODES.has(error.code)) {
        captureUnexpectedError(new Error('calendar token rotation recovery was rejected'), {
          feature: 'external_calendar',
          operation: 'prepare_rotated_refresh_token_recovery',
          source: 'supabase_rpc',
        });
        return 'unresolved';
      }
    } catch {
      // response欠落とrollbackを区別できないため、同じoperation/payloadで再試行する。
    }
  }

  captureUnexpectedError(new Error('calendar token rotation recovery is unresolved'), {
    feature: 'external_calendar',
    operation: 'prepare_rotated_refresh_token_recovery',
    source: 'supabase_rpc',
  });
  return 'unresolved';
}

async function compensateCalendarTokenRotation(
  provider: Pick<CalendarProviderAdapter, 'revoke'>,
  rotatedRefreshToken: string,
): Promise<boolean> {
  let confirmed = false;
  try {
    confirmed = await provider.revoke(rotatedRefreshToken);
  } catch {
    // provider errorにtokenが含まれる可能性があるためcauseとして保持しない。
  }

  if (!confirmed) {
    captureUnexpectedError(new Error('calendar token rotation compensation was not confirmed'), {
      feature: 'external_calendar',
      operation: 'revoke_unpersisted_refresh_token',
      source: 'google_token_endpoint',
    });
  }

  return confirmed;
}
