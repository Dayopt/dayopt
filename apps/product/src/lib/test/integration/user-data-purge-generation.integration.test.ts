import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authenticated = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const foreignUserId = crypto.randomUUID();
const password = 'test-password-123';
const userEmail = `purge-generation-${userId}@example.com`;
const foreignEmail = `purge-generation-${foreignUserId}@example.com`;
const resourceUri = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const dbNull = null as never;

function instant(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function runOwnerSql(sql: string) {
  return spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      sql,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: 'postgres' },
    },
  );
}

async function holdCalendarTokenRotation(
  operationId: string,
  connectionId: string,
  expectedGeneration: number,
  expectedRefreshTokenEnc: string,
  newRefreshTokenEnc: string,
): Promise<{ release: (commit?: boolean) => Promise<void> }> {
  const child = spawn(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `operation_id=${operationId}`,
      '-v',
      `connection_id=${connectionId}`,
      '-v',
      `expected_generation=${expectedGeneration}`,
      '-v',
      `expected_refresh_token_enc=${expectedRefreshTokenEnc}`,
      '-v',
      `new_refresh_token_enc=${newRefreshTokenEnc}`,
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(`
BEGIN;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
SELECT public.rotate_or_enqueue_calendar_refresh_token_command_v2(
  :'operation_id'::UUID,
  '${userId}'::UUID,
  :'connection_id'::UUID,
  :'expected_generation'::BIGINT,
  :'expected_refresh_token_enc',
  :'new_refresh_token_enc'
);
SELECT 'LOCKED';
`);

  const deadline = Date.now() + 5_000;
  while (!stdout.includes('LOCKED')) {
    if (child.exitCode !== null) throw new Error(`Token rotation holder exited: ${stderr}`);
    if (Date.now() >= deadline) throw new Error(`Timed out holding Calendar token row: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    release: async (commit = true) => {
      if (child.exitCode !== null) return;
      child.stdin.end(commit ? 'COMMIT;\n' : 'ROLLBACK;\n');
      await once(child, 'close');
    },
  };
}

async function holdPurge(): Promise<{ release: (commit?: boolean) => Promise<void> }> {
  const child = spawn(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(`
BEGIN;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
SELECT public.delete_all_user_data_command_v3('${userId}'::UUID);
SELECT 'PURGED';
`);

  const deadline = Date.now() + 5_000;
  while (!stdout.includes('PURGED')) {
    if (child.exitCode !== null) throw new Error(`Purge holder exited: ${stderr}`);
    if (Date.now() >= deadline) throw new Error(`Timed out holding purge transaction: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    release: async (commit = true) => {
      if (child.exitCode !== null) return;
      child.stdin.end(commit ? 'COMMIT;\n' : 'ROLLBACK;\n');
      await once(child, 'close');
    },
  };
}

async function waitForPurgeLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = runOwnerSql(`
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%delete_all_user_data_command_v3%';
    `);
    if (result.status === 0 && Number(result.stdout.trim()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for purge to lock the Calendar token row');
}

async function waitForRotationLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = runOwnerSql(`
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%rotate_or_enqueue_calendar_refresh_token_command_v2%';
    `);
    if (result.status === 0 && Number(result.stdout.trim()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Calendar token rotation to lock');
}

async function currentGeneration(targetUserId = userId): Promise<number> {
  const { data, error } = await admin.rpc('get_user_data_generation_v1', {
    p_user_id: targetUserId,
  });
  if (error || data === null) throw error ?? new Error('missing user data generation');
  return data;
}

async function purge(targetUserId = userId): Promise<void> {
  const { data, error } = await admin.rpc('delete_all_user_data_command_v3', {
    p_user_id: targetUserId,
  });
  if (error || data !== true) throw error ?? new Error('purge did not complete');
}

async function saveCalendarConnection(
  expectedGeneration: number,
  targetUserId = userId,
  refreshTokenEnc = `v1.${crypto.randomUUID()}.ciphertext`,
): Promise<string> {
  const { data, error } = await admin.rpc('save_calendar_connection_command_v1', {
    p_user_id: targetUserId,
    p_expected_generation: expectedGeneration,
    p_provider: 'google',
    p_provider_account_id: `provider-${crypto.randomUUID()}`,
    p_provider_account_email: 'calendar@example.com',
    p_granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    p_refresh_token_enc: refreshTokenEnc,
  });
  if (error || !data) throw error ?? new Error('calendar connection was not saved');
  return data;
}

async function createOAuthAuthority(): Promise<{
  codeHash: string;
  connectionId: string;
}> {
  const codeHash = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: resourceUri,
      p_scopes: ['read:entries'],
      p_code_hash: codeHash,
      p_redirect_uri: redirectUri,
      p_code_challenge: 'challenge',
      p_write_enabled: false,
    },
  );
  if (grantError || !connectionId) throw grantError ?? new Error('OAuth grant was not created');

  const { error: exchangeError } = await admin.rpc('exchange_oauth_authorization_code_v2', {
    p_code_hash: codeHash,
    p_client_id: 'chatgpt',
    p_redirect_uri: redirectUri,
    p_resource_uri: resourceUri,
    p_code_challenge: 'challenge',
    p_refresh_hash: `refresh-${crypto.randomUUID()}`,
    p_access_hash: `access-${crypto.randomUUID()}`,
  });
  if (exchangeError) throw exchangeError;

  return { codeHash, connectionId };
}

describe.skipIf(!RUN_LOCAL)('account-preserving user-data purge generation', () => {
  beforeAll(async () => {
    for (const [id, email] of [
      [userId, userEmail],
      [foreignUserId, foreignEmail],
    ] as const) {
      const { error } = await admin.auth.admin.createUser({
        id,
        email,
        password,
        email_confirm: true,
      });
      if (error) throw error;
    }

    const { error: signInError } = await authenticated.auth.signInWithPassword({
      email: userEmail,
      password,
    });
    if (signInError) throw signInError;
  });

  afterEach(async () => {
    await purge(userId);
    await purge(foreignUserId);
  });

  afterAll(async () => {
    await authenticated.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
    await admin.auth.admin.deleteUser(foreignUserId);
  });

  it('deletes domain and external authority while preserving account state and tombstones', async () => {
    const generation = await currentGeneration();
    const connectionId = await saveCalendarConnection(generation);
    const calendarId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const activityId = crypto.randomUUID();
    const receiptOperationId = crypto.randomUUID();
    const receiptResourceId = crypto.randomUUID();
    const { codeHash, connectionId: oauthConnectionId } = await createOAuthAuthority();

    const { error: calendarError } = await admin.from('calendar_connection_calendars').insert({
      id: calendarId,
      connection_id: connectionId,
      user_id: userId,
      provider_calendar_id: 'primary',
      calendar_name: 'Primary',
      sync_token: 'cursor',
    });
    expect(calendarError).toBeNull();

    const { error: eventError } = await admin.from('external_calendar_events').insert({
      id: eventId,
      user_id: userId,
      connection_id: connectionId,
      provider: 'google',
      provider_calendar_id: 'primary',
      provider_event_id: 'event-1',
      title: 'Imported event',
      start_at: instant(60 * 60_000),
      end_at: instant(2 * 60 * 60_000),
      status: 'confirmed',
      last_synced_at: instant(),
    });
    expect(eventError).toBeNull();

    // Plan / Record の FK 先を先に確定する。Promise.all に含めると、PostgREST request の
    // 到着順次第で activity commit 前に子が insert され、fixture 自体が非決定的に失敗する。
    const { error: activityError } = await admin.from('activities').insert({
      id: activityId,
      user_id: userId,
      name: 'Purge me',
    });
    expect(activityError).toBeNull();

    const fixtureResults = await Promise.all([
      admin
        .from('user_settings')
        .upsert({ user_id: userId, timezone: 'Asia/Tokyo' }, { onConflict: 'user_id' }),
      admin.from('plans').insert({
        user_id: userId,
        title: 'Purge Plan',
        external_calendar_event_id: eventId,
        source: 'external_calendar',
        start_at: instant(3 * 60 * 60_000),
        end_at: instant(4 * 60 * 60_000),
      }),
      admin.from('records').insert({
        user_id: userId,
        title: 'Purge Record',
        start_at: instant(-4 * 60 * 60_000),
        end_at: instant(-3 * 60 * 60_000),
      }),
      admin.from('reports').insert({
        user_id: userId,
        period_type: 'weekly',
        period_start: '2026-07-20',
        period_end: '2026-07-26',
        summary: 'Private summary',
        content: { private: true },
      }),
      admin.from('mfa_recovery_codes').insert({
        user_id: userId,
        code_hash: `mfa-${crypto.randomUUID()}`,
      }),
      admin.from('reports').insert({
        user_id: foreignUserId,
        period_type: 'weekly',
        period_start: '2026-07-20',
        period_end: '2026-07-26',
        summary: 'Foreign summary',
        content: { foreign: true },
      }),
    ]);
    for (const result of fixtureResults) expect(result.error).toBeNull();

    const receiptInsert = runOwnerSql(`
      INSERT INTO public.mcp_mutation_receipts (
        user_id,
        client_id,
        operation_id,
        origin_connection_id,
        envelope_version,
        tool_name,
        request_digest,
        resource_type,
        resource_id,
        resource_version
      ) VALUES (
        '${userId}'::UUID,
        'chatgpt',
        '${receiptOperationId}'::UUID,
        '${oauthConnectionId}'::UUID,
        1,
        'plans.create',
        private.digest_mcp_mutation_envelope_v1(
          'plans.create',
          '{"title":"purged"}'::JSONB
        ),
        'plan',
        '${receiptResourceId}'::UUID,
        pg_catalog.clock_timestamp()
      );
    `);
    expect(receiptInsert.status, receiptInsert.stderr).toBe(0);

    await purge();

    expect(await currentGeneration()).toBe(generation + 1);

    for (const table of [
      'plans',
      'records',
      'activities',
      'user_settings',
      'reports',
      'calendar_connections',
      'calendar_connection_calendars',
      'external_calendar_events',
    ] as const) {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(table === 'user_settings' ? 'user_id' : 'user_id', userId);
      expect(error).toBeNull();
      expect(count, table).toBe(0);
    }

    const [{ data: profile }, { count: mfaCount }, { count: foreignReportCount }] =
      await Promise.all([
        admin.from('profiles').select('id, subscription_status').eq('id', userId).single(),
        admin
          .from('mfa_recovery_codes')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId),
        admin
          .from('reports')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', foreignUserId),
      ]);
    expect(profile?.id).toBe(userId);
    expect(mfaCount).toBe(1);
    expect(foreignReportCount).toBe(1);

    const [{ data: oauthConnection }, { data: code }, { data: tokens }, { data: receipt }] =
      await Promise.all([
        admin
          .from('oauth_connections')
          .select('revoked_at, revoked_reason')
          .eq('id', oauthConnectionId)
          .single(),
        admin
          .from('oauth_authorization_codes')
          .select('consumed_at')
          .eq('code_hash', codeHash)
          .single(),
        admin.from('oauth_tokens').select('revoked_at').eq('connection_id', oauthConnectionId),
        admin
          .from('mcp_mutation_receipts')
          .select('data_generation, purged_generation, purged_at, resource_deleted_at')
          .eq('operation_id', receiptOperationId)
          .single(),
      ]);
    expect(oauthConnection?.revoked_at).toBeTruthy();
    expect(oauthConnection?.revoked_reason).toBe('user_data_purge');
    expect(code?.consumed_at).toBeTruthy();
    expect(tokens).toHaveLength(2);
    expect(tokens?.every((token) => token.revoked_at !== null)).toBe(true);
    expect(receipt).toMatchObject({
      data_generation: generation,
      purged_generation: generation + 1,
    });
    expect(receipt?.purged_at).toBeTruthy();
    expect(receipt?.resource_deleted_at).toBeTruthy();

    const privateState = runOwnerSql(`
      SELECT
        (
          SELECT pg_catalog.count(*)
          FROM private.calendar_revoke_outbox
          WHERE user_id = '${userId}'::UUID
            AND source_connection_id = '${connectionId}'::UUID
        ),
        (
          SELECT pg_catalog.count(*)
          FROM private.integration_security_events
          WHERE user_id = '${userId}'::UUID
            AND event_kind = 'user_data_purged'
        );
    `);
    expect(privateState.status, privateState.stderr).toBe(0);
    expect(privateState.stdout.trim()).toBe('1|1');

    const replay = runOwnerSql(`
      SELECT *
      FROM private.resolve_mcp_mutation_replay_v1(
        '${userId}'::UUID,
        'chatgpt'::TEXT,
        '${receiptOperationId}'::UUID,
        'plans.create'::TEXT,
        private.digest_mcp_mutation_envelope_v1(
          'plans.create',
          '{"title":"purged"}'::JSONB
        ),
        1::SMALLINT,
        'plan'::TEXT
      );
    `);
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('MCP mutation result was removed by user data deletion');

    const mismatchedReplay = runOwnerSql(`
      SELECT *
      FROM private.resolve_mcp_mutation_replay_v1(
        '${userId}'::UUID,
        'chatgpt'::TEXT,
        '${receiptOperationId}'::UUID,
        'plans.create'::TEXT,
        private.digest_mcp_mutation_envelope_v1(
          'plans.create',
          '{"title":"different"}'::JSONB
        ),
        1::SMALLINT,
        'plan'::TEXT
      );
    `);
    expect(mismatchedReplay.status).not.toBe(0);
    expect(mismatchedReplay.stderr).toContain(
      'MCP operation ID was reused for a different request',
    );
  });

  it('rejects a Calendar callback bound to the generation before purge', async () => {
    const generation = await currentGeneration();
    await purge();

    const stale = await admin.rpc('save_calendar_connection_command_v1', {
      p_user_id: userId,
      p_expected_generation: generation,
      p_provider: 'google',
      p_provider_account_id: `stale-${crypto.randomUUID()}`,
      p_provider_account_email: dbNull,
      p_granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      p_refresh_token_enc: `v1.${crypto.randomUUID()}.ciphertext`,
    });
    expect(stale.error).toMatchObject({ code: 'DG002' });

    const { count } = await admin
      .from('calendar_connections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    expect(count).toBe(0);

    const freshConnectionId = await saveCalendarConnection(generation + 1);
    expect(freshConnectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('waits for a concurrent Calendar token rotation and captures the committed ciphertext', async () => {
    const generation = await currentGeneration();
    const originalCiphertext = `v1.original-${crypto.randomUUID()}.ciphertext`;
    const connectionId = await saveCalendarConnection(generation, userId, originalCiphertext);
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const holder = await holdCalendarTokenRotation(
      crypto.randomUUID(),
      connectionId,
      generation,
      originalCiphertext,
      rotatedCiphertext,
    );
    const purgeRequest = Promise.resolve(
      admin.rpc('delete_all_user_data_command_v3', {
        p_user_id: userId,
      }),
    );

    try {
      await waitForPurgeLockWaiter();
      await holder.release();

      const { data, error } = await purgeRequest;
      expect(error).toBeNull();
      expect(data).toBe(true);

      const outboxToken = runOwnerSql(`
        SELECT refresh_token_enc
        FROM private.calendar_revoke_outbox
        WHERE user_id = '${userId}'::UUID
          AND source_connection_id = '${connectionId}'::UUID;
      `);
      expect(outboxToken.status, outboxToken.stderr).toBe(0);
      expect(outboxToken.stdout.trim()).toBe(rotatedCiphertext);
    } finally {
      await holder.release(false);
    }
  });

  it('replays the same rotation operation without overwriting a concurrently changed token', async () => {
    const generation = await currentGeneration();
    const originalCiphertext = `v1.original-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const conflictingCiphertext = `v1.conflict-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, originalCiphertext);
    const args = {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: originalCiphertext,
      p_new_refresh_token_enc: rotatedCiphertext,
    };

    const first = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', args);
    const replay = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', args);
    expect(first.error).toBeNull();
    expect(first.data).toBe('updated');
    expect(replay.error).toBeNull();
    expect(replay.data).toBe('updated');

    const conflict = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
      ...args,
      p_operation_id: crypto.randomUUID(),
      p_new_refresh_token_enc: conflictingCiphertext,
    });
    expect(conflict.error?.code).toBe('CA002');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('refresh_token_enc, refresh_token_rotation_operation_id')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toEqual({
      refresh_token_enc: rotatedCiphertext,
      refresh_token_rotation_operation_id: operationId,
    });
  });

  it('marks only the observed Calendar token authority for reauthorization', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    const markedAt = instant();

    const marked = await admin.rpc('mark_calendar_connection_reauth_command_v2', {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_last_synced_at: markedAt,
    });
    expect(marked.error).toBeNull();
    expect(marked.data).toBe('marked');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('status, last_sync_error, last_synced_at')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toMatchObject({
      status: 'reauth_required',
      last_sync_error: 'reauth_required',
    });
    expect(new Date(connection!.last_synced_at!).toISOString()).toBe(markedAt);
  });

  it('marks the exact rotation operation after its commit response is lost', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    const rotation = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_new_refresh_token_enc: rotatedCiphertext,
    });
    expect(rotation.error).toBeNull();
    expect(rotation.data).toBe('updated');

    const fallback = await admin.rpc('mark_calendar_connection_reauth_command_v2', {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_operation_id: operationId,
      p_new_refresh_token_enc: rotatedCiphertext,
      p_last_synced_at: instant(),
    });
    expect(fallback.error).toBeNull();
    expect(fallback.data).toBe('marked');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('status, refresh_token_enc')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toEqual({
      status: 'reauth_required',
      refresh_token_enc: rotatedCiphertext,
    });
  });

  it('does not overwrite a reconnect that retained an older rotation operation ID', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const reconnectedCiphertext = `v1.reconnected-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    const rotation = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_new_refresh_token_enc: rotatedCiphertext,
    });
    expect(rotation.error).toBeNull();
    expect(rotation.data).toBe('updated');

    const { error: reconnectError } = await admin
      .from('calendar_connections')
      .update({ refresh_token_enc: reconnectedCiphertext })
      .eq('id', connectionId)
      .eq('user_id', userId);
    expect(reconnectError).toBeNull();

    const fallback = await admin.rpc('mark_calendar_connection_reauth_command_v2', {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_operation_id: operationId,
      p_new_refresh_token_enc: rotatedCiphertext,
      p_last_synced_at: instant(),
    });
    expect(fallback.error).toBeNull();
    expect(fallback.data).toBe('superseded');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('status, refresh_token_enc')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toEqual({
      status: 'active',
      refresh_token_enc: reconnectedCiphertext,
    });
  });

  it('prepares provider recovery by fail-closing a superseding authority and durably queuing the rotated token', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const reconnectedCiphertext = `v1.reconnected-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    const { error: reconnectError } = await admin
      .from('calendar_connections')
      .update({ refresh_token_enc: reconnectedCiphertext })
      .eq('id', connectionId)
      .eq('user_id', userId);
    expect(reconnectError).toBeNull();

    const args = {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_new_refresh_token_enc: rotatedCiphertext,
      p_last_synced_at: instant(),
    };
    const prepared = await admin.rpc('prepare_calendar_token_rotation_recovery_command_v1', args);
    const replay = await admin.rpc('prepare_calendar_token_rotation_recovery_command_v1', args);
    expect(prepared.error).toBeNull();
    expect(prepared.data).toBe('marked');
    expect(replay.error).toBeNull();
    expect(replay.data).toBe('marked');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('status, last_sync_error, refresh_token_enc')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toEqual({
      status: 'reauth_required',
      last_sync_error: 'reauth_required',
      refresh_token_enc: reconnectedCiphertext,
    });

    const queued = runOwnerSql(`
      SELECT pg_catalog.concat(id, '|', refresh_token_enc)
      FROM private.calendar_revoke_outbox
      WHERE id = '${operationId}'::UUID;
    `);
    expect(queued.status, queued.stderr).toBe(0);
    expect(queued.stdout.trim()).toBe(`${operationId}|${rotatedCiphertext}`);

    const reusedOperation = await admin.rpc('prepare_calendar_token_rotation_recovery_command_v1', {
      ...args,
      p_new_refresh_token_enc: `v1.reused-${crypto.randomUUID()}.ciphertext`,
    });
    expect(reusedOperation.error?.code).toBe('CA004');
  });

  it('queues the rotated token and reports missing when purge already advanced the generation', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    await purge();

    const recovery = await admin.rpc('prepare_calendar_token_rotation_recovery_command_v1', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_new_refresh_token_enc: rotatedCiphertext,
      p_last_synced_at: instant(),
    });
    expect(recovery.error).toBeNull();
    expect(recovery.data).toBe('missing');

    const outboxTokens = runOwnerSql(`
      SELECT refresh_token_enc
      FROM private.calendar_revoke_outbox
      WHERE user_id = '${userId}'::UUID
        AND source_connection_id = '${connectionId}'::UUID
        AND refresh_token_enc IN ('${observedCiphertext}', '${rotatedCiphertext}')
      ORDER BY refresh_token_enc;
    `);
    expect(outboxTokens.status, outboxTokens.stderr).toBe(0);
    expect(outboxTokens.stdout.trim().split('\n').sort()).toEqual(
      [observedCiphertext, rotatedCiphertext].sort(),
    );
  });

  it('fail-closes the current authority before direct compensation when encryption is unavailable', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    const operationId = crypto.randomUUID();

    const recovery = await admin.rpc('prepare_calendar_token_rotation_recovery_command_v1', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_last_synced_at: instant(),
    });
    expect(recovery.error).toBeNull();
    expect(recovery.data).toBe('marked');

    const { data: connection, error: connectionError } = await admin
      .from('calendar_connections')
      .select('status, last_sync_error')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection).toEqual({
      status: 'reauth_required',
      last_sync_error: 'reauth_required',
    });

    const queued = runOwnerSql(`
      SELECT pg_catalog.count(*)
      FROM private.calendar_revoke_outbox
      WHERE id = '${operationId}'::UUID;
    `);
    expect(queued.status, queued.stderr).toBe(0);
    expect(queued.stdout.trim()).toBe('0');
  });

  it('reports a Calendar reauth fallback as missing after purge advances the generation', async () => {
    const generation = await currentGeneration();
    const observedCiphertext = `v1.observed-${crypto.randomUUID()}.ciphertext`;
    const connectionId = await saveCalendarConnection(generation, userId, observedCiphertext);
    await purge();

    const fallback = await admin.rpc('mark_calendar_connection_reauth_command_v2', {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_generation: generation,
      p_expected_refresh_token_enc: observedCiphertext,
      p_last_synced_at: instant(),
    });
    expect(fallback.error).toBeNull();
    expect(fallback.data).toBe('missing');
  });

  it('enqueues a token acquired while purge commits first without losing the captured old token', async () => {
    const generation = await currentGeneration();
    const originalCiphertext = `v1.original-${crypto.randomUUID()}.ciphertext`;
    const rotatedCiphertext = `v1.rotated-${crypto.randomUUID()}.ciphertext`;
    const operationId = crypto.randomUUID();
    const connectionId = await saveCalendarConnection(generation, userId, originalCiphertext);
    const holder = await holdPurge();
    const rotationRequest = Promise.resolve(
      admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
        p_operation_id: operationId,
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_generation: generation,
        p_expected_refresh_token_enc: originalCiphertext,
        p_new_refresh_token_enc: rotatedCiphertext,
      }),
    );

    try {
      await waitForRotationLockWaiter();
      await holder.release();

      const { data, error } = await rotationRequest;
      expect(error).toBeNull();
      expect(data).toBe('enqueued');

      const replay = await admin.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
        p_operation_id: operationId,
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_generation: generation,
        p_expected_refresh_token_enc: originalCiphertext,
        p_new_refresh_token_enc: rotatedCiphertext,
      });
      expect(replay.error).toBeNull();
      expect(replay.data).toBe('enqueued');

      const reusedOperation = await admin.rpc(
        'rotate_or_enqueue_calendar_refresh_token_command_v2',
        {
          p_operation_id: operationId,
          p_user_id: userId,
          p_connection_id: connectionId,
          p_expected_generation: generation,
          p_expected_refresh_token_enc: originalCiphertext,
          p_new_refresh_token_enc: `v1.reused-${crypto.randomUUID()}.ciphertext`,
        },
      );
      expect(reusedOperation.error?.code).toBe('CA004');

      const { count: connectionCount } = await admin
        .from('calendar_connections')
        .select('id', { count: 'exact', head: true })
        .eq('id', connectionId)
        .eq('user_id', userId);
      expect(connectionCount).toBe(0);

      const outboxTokens = runOwnerSql(`
        SELECT refresh_token_enc
        FROM private.calendar_revoke_outbox
        WHERE user_id = '${userId}'::UUID
          AND source_connection_id = '${connectionId}'::UUID
          AND refresh_token_enc IN ('${originalCiphertext}', '${rotatedCiphertext}')
        ORDER BY refresh_token_enc;
      `);
      expect(outboxTokens.status, outboxTokens.stderr).toBe(0);
      expect(outboxTokens.stdout.trim().split('\n').sort()).toEqual(
        [originalCiphertext, rotatedCiphertext].sort(),
      );
    } finally {
      await holder.release(false);
    }
  });

  it('keeps generation, save, and full purge RPCs unavailable to browser roles', async () => {
    const generation = await currentGeneration();
    const [generationRead, save, rotate, markReauth, prepareRecovery, fullPurge] =
      await Promise.all([
        authenticated.rpc('get_user_data_generation_v1', { p_user_id: userId }),
        authenticated.rpc('save_calendar_connection_command_v1', {
          p_user_id: userId,
          p_expected_generation: generation,
          p_provider: 'google',
          p_provider_account_id: `forbidden-${crypto.randomUUID()}`,
          p_provider_account_email: dbNull,
          p_granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          p_refresh_token_enc: 'forbidden-ciphertext',
        }),
        authenticated.rpc('rotate_or_enqueue_calendar_refresh_token_command_v2', {
          p_operation_id: crypto.randomUUID(),
          p_user_id: userId,
          p_connection_id: crypto.randomUUID(),
          p_expected_generation: generation,
          p_expected_refresh_token_enc: 'forbidden-old-ciphertext',
          p_new_refresh_token_enc: 'forbidden-new-ciphertext',
        }),
        authenticated.rpc('mark_calendar_connection_reauth_command_v2', {
          p_user_id: userId,
          p_connection_id: crypto.randomUUID(),
          p_expected_generation: generation,
          p_expected_refresh_token_enc: 'forbidden-ciphertext',
          p_last_synced_at: instant(),
        }),
        authenticated.rpc('prepare_calendar_token_rotation_recovery_command_v1', {
          p_operation_id: crypto.randomUUID(),
          p_user_id: userId,
          p_connection_id: crypto.randomUUID(),
          p_expected_generation: generation,
          p_expected_refresh_token_enc: 'forbidden-old-ciphertext',
          p_new_refresh_token_enc: 'forbidden-new-ciphertext',
          p_last_synced_at: instant(),
        }),
        authenticated.rpc('delete_all_user_data_command_v3', { p_user_id: userId }),
      ]);

    expect(generationRead.error?.code).toBe('42501');
    expect(save.error?.code).toBe('42501');
    expect(rotate.error?.code).toBe('42501');
    expect(markReauth.error?.code).toBe('42501');
    expect(prepareRecovery.error?.code).toBe('42501');
    expect(fullPurge.error?.code).toBe('42501');
  });
});
