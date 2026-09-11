import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { hashToken } from '@/lib/oauth-server';

import { deriveStage1PkceS256Challenge } from './mcp-stage1-crypto';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `mcp-plan-create-${userId}@example.com`;
const password = 'test-password-123';
const resource = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));
const dbNull = null as never;

interface WriteAuthorization {
  accessTokenId: string;
  connectionId: string;
}

interface PlanCreateInput {
  operationId: string;
  title: string;
  note?: string | null;
  startAt: string;
  endAt: string;
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function asOffset(instant: string, offsetHours: number): string {
  const offsetMs = offsetHours * 60 * 60_000;
  const shifted = new Date(new Date(instant).getTime() + offsetMs).toISOString().replace('Z', '');
  const sign = offsetHours >= 0 ? '+' : '-';
  return `${shifted}${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
}

async function readMutationControl() {
  const { data, error } = await admin
    .from('mcp_mutation_control')
    .select('writes_enabled, enabled_client_ids, revision')
    .eq('singleton_key', true)
    .single();
  if (error) throw error;
  return data;
}

async function setClientWriteControl(enabled: boolean) {
  const current = await readMutationControl();
  const { data, error } = await admin.rpc('set_mcp_client_write_control_v1', {
    p_client_id: 'chatgpt',
    p_enabled: enabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
  return data[0]!;
}

async function setMutationControl(writesEnabled: boolean) {
  const current = await readMutationControl();
  const { data, error } = await admin.rpc('set_mcp_mutation_control_v1', {
    p_writes_enabled: writesEnabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
  return data[0]!;
}

async function createWriteAuthorization(targetUserId = userId): Promise<WriteAuthorization> {
  const code = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: targetUserId,
      p_client_id: 'chatgpt',
      p_resource_uri: resource,
      p_scopes: ['read:entries', 'write:plans'],
      p_code_hash: hashToken(code),
      p_redirect_uri: redirectUri,
      p_code_challenge: challenge,
      p_write_enabled: true,
    },
  );
  if (grantError || !connectionId) throw grantError ?? new Error('Connection was not created');

  const { data: exchange, error: exchangeError } = await admin.rpc(
    'exchange_oauth_authorization_code_v2',
    {
      p_code_hash: hashToken(code),
      p_client_id: 'chatgpt',
      p_redirect_uri: redirectUri,
      p_resource_uri: resource,
      p_code_challenge: challenge,
      p_refresh_hash: hashToken(`dop_rt_${crypto.randomUUID()}`),
      p_access_hash: hashToken(`dop_at_${crypto.randomUUID()}`),
    },
  );
  if (exchangeError) throw exchangeError;
  const accessTokenId = exchange?.[0]?.access_id;
  if (!accessTokenId) throw new Error('Access token was not issued');

  return { accessTokenId, connectionId };
}

function applyPlan(authorization: WriteAuthorization, input: PlanCreateInput) {
  return admin
    .rpc('apply_mcp_plan_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: input.operationId,
      p_title: input.title,
      p_note: (input.note ?? null) as never,
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
}

function psqlArgs(variables: Record<string, string> = {}): string[] {
  return [
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
    ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
    '-h',
    '127.0.0.1',
    '-p',
    '54322',
    '-U',
    'postgres',
    '-d',
    'postgres',
  ];
}

function psqlEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: 'postgres' };
}

function runOwnerSql(sql: string): string {
  return execFileSync('psql', psqlArgs(), {
    env: psqlEnv(),
    encoding: 'utf8',
    input: sql,
  }).trim();
}

async function holdOperationLock(
  targetUserId: string,
  operationId: string,
): Promise<{ process: ChildProcessWithoutNullStreams; release: () => Promise<void> }> {
  const process = spawn(
    'psql',
    psqlArgs({ user_id: targetUserId, client_id: 'chatgpt', operation_id: operationId }),
    { env: psqlEnv() },
  );
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  process.stdin.write(
    "BEGIN; SELECT private.lock_mcp_mutation_operation_v1(:'user_id'::UUID, :'client_id', :'operation_id'::UUID); SELECT 'LOCKED';\n",
  );

  const deadline = Date.now() + 5_000;
  while (!stdout.includes('LOCKED')) {
    if (process.exitCode !== null) throw new Error(`Lock holder exited: ${stderr}`);
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring operation lock: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    process,
    release: async () => {
      if (process.exitCode !== null) return;
      process.stdin.end('ROLLBACK;\n');
      await once(process, 'close');
    },
  };
}

async function waitForAdvisoryWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await new Promise<string>((resolve, reject) => {
      const process = spawn(
        'psql',
        [
          ...psqlArgs(),
          '-c',
          "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        ],
        { env: psqlEnv() },
      );
      let stdout = '';
      let stderr = '';
      process.stdout.setEncoding('utf8');
      process.stderr.setEncoding('utf8');
      process.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      process.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      process.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr));
      });
    });
    if (Number(result) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the apply transaction to reach the advisory lock');
}

describe.skipIf(!RUN_LOCAL)('MCP Plan create apply integration', () => {
  beforeAll(async () => {
    const { error: createError } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;

    const { error: profileError } = await admin
      .from('profiles')
      .update({ subscription_status: 'active' })
      .eq('id', userId);
    if (profileError) throw profileError;

    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;

    await setClientWriteControl(true);
    await setMutationControl(true);
  });

  afterEach(async () => {
    await admin.from('plans').delete().eq('user_id', userId);
  });

  afterAll(async () => {
    await setMutationControl(false);
    await setClientWriteControl(false);
    await userClient.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  it('creates one API Plan and replays the exact receipt across timestamp representations', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const startAt = at(60 * 60_000);
    const input: PlanCreateInput = {
      operationId,
      title: 'Canonical Plan',
      note: null,
      startAt,
      endAt: at(2 * 60 * 60_000),
    };

    const first = await applyPlan(authorization, input);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      schema_version: 1,
      operation_id: operationId,
      resource_type: 'plan',
      deleted_at: null,
      replayed: false,
    });

    const replay = await applyPlan(authorization, {
      ...input,
      startAt: asOffset(input.startAt, 9),
      endAt: asOffset(input.endAt, 9),
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...first.data!, replayed: true });

    const { data: plan, error: planError } = await admin
      .from('plans')
      .select('id, source, updated_at')
      .eq('user_id', userId)
      .single();
    expect(planError).toBeNull();
    expect(plan).toMatchObject({
      id: first.data?.resource_id,
      source: 'api',
      updated_at: first.data?.version,
    });

    const { data: receipts, error: receiptError } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id, tool_name, request_digest')
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(receiptError).toBeNull();
    expect(receipts).toHaveLength(1);
    expect(receipts?.[0]).toMatchObject({ operation_id: operationId, tool_name: 'plans.create' });
    expect(receipts?.[0]?.request_digest).toMatch(/^\\x[0-9a-f]{64}$/);

    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan!.id,
        p_expected_updated_at: plan!.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();
    expect(deleted?.deleted_at).not.toBeNull();

    const replayAfterDelete = await applyPlan(authorization, input);
    expect(replayAfterDelete.error).toBeNull();
    expect(replayAfterDelete.data).toEqual({ ...first.data!, replayed: true });
  });

  it('rejects replay after the receipt crosses a user-data generation', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const input: PlanCreateInput = {
      operationId,
      title: 'Purged generation Plan',
      startAt: at(17 * 60 * 60_000),
      endAt: at(18 * 60 * 60_000),
    };

    const applied = await applyPlan(authorization, input);
    expect(applied.error).toBeNull();

    const { data: receipt, error: receiptError } = await admin
      .from('mcp_mutation_receipts')
      .select('data_generation, purged_generation, resource_id')
      .eq('user_id', userId)
      .eq('operation_id', operationId)
      .single();
    expect(receiptError).toBeNull();
    expect(receipt).toMatchObject({
      data_generation: 0,
      purged_generation: null,
    });

    runOwnerSql(`
      BEGIN;

      UPDATE private.user_data_controls
      SET
        generation = generation + 1,
        changed_at = pg_catalog.clock_timestamp()
      WHERE user_id = '${userId}';

      UPDATE public.plans
      SET deleted_at = pg_catalog.clock_timestamp()
      WHERE id = '${receipt!.resource_id}';

      UPDATE public.mcp_mutation_receipts
      SET
        purged_generation = data_generation + 1,
        purged_at = pg_catalog.clock_timestamp(),
        resource_deleted_at = pg_catalog.clock_timestamp()
      WHERE user_id = '${userId}'
        AND operation_id = '${operationId}';

      COMMIT;
    `);

    const staleReplay = await applyPlan(authorization, input);
    expect(staleReplay.error?.code).toBe('DM008');
  });

  it('serializes parallel retries into one Plan, one receipt, and one replay', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const input: PlanCreateInput = {
      operationId,
      title: 'Parallel retry',
      startAt: at(3 * 60 * 60_000),
      endAt: at(4 * 60 * 60_000),
    };

    const attempts = await Promise.all([
      applyPlan(authorization, input),
      applyPlan(authorization, input),
    ]);
    expect(attempts.every(({ error }) => error === null)).toBe(true);
    expect(attempts.map(({ data }) => data?.replayed).sort()).toEqual([false, true]);
    expect(new Set(attempts.map(({ data }) => data?.resource_id))).toHaveLength(1);
    expect(new Set(attempts.map(({ data }) => data?.version))).toHaveLength(1);

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(planCount).toBe(1);
    expect(receiptCount).toBe(1);
  });

  it('rejects operation ID reuse with different typed arguments', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const input: PlanCreateInput = {
      operationId,
      title: 'Original request',
      startAt: at(5 * 60 * 60_000),
      endAt: at(6 * 60 * 60_000),
    };
    const first = await applyPlan(authorization, input);
    expect(first.error).toBeNull();

    const reused = await applyPlan(authorization, { ...input, title: 'Different request' });
    expect(reused.error?.code).toBe('DM006');

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(planCount).toBe(1);
    expect(receiptCount).toBe(1);
  });

  it('allows only one of normal UI and MCP create to occupy the same Plan range', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const startAt = at(7 * 60 * 60_000);
    const endAt = at(8 * 60 * 60_000);
    const attempts = await Promise.all([
      applyPlan(authorization, {
        operationId,
        title: 'MCP writer',
        startAt,
        endAt,
      }),
      // 通常 UI の write は Candidate 6 以降 service-owned command boundary を通る
      // （authenticated の直接 DML は剥がした）
      admin.rpc('create_plan_command_v1', {
        p_user_id: userId,
        p_title: 'UI writer',
        p_note: dbNull,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: startAt,
        p_end_at: endAt,
      }),
    ]);

    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(planCount).toBe(1);
    expect(receiptCount).toBe(attempts[0].error ? 0 : 1);
  });

  it('rolls back a failed domain write and lets the same operation ID retry corrected input', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const occupiedStart = at(9 * 60 * 60_000);
    const occupiedEnd = at(10 * 60 * 60_000);
    const { error: seedError } = await admin.rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: 'Occupied range',
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: occupiedStart,
      p_end_at: occupiedEnd,
    });
    expect(seedError).toBeNull();

    const failed = await applyPlan(authorization, {
      operationId,
      title: 'Rejected overlap',
      startAt: occupiedStart,
      endAt: occupiedEnd,
    });
    expect(['23P01', '40P01']).toContain(failed.error?.code);
    const { count: failedReceiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(failedReceiptCount).toBe(0);

    const corrected = await applyPlan(authorization, {
      operationId,
      title: 'Corrected retry',
      startAt: at(11 * 60 * 60_000),
      endAt: at(12 * 60 * 60_000),
    });
    expect(corrected.error).toBeNull();
    expect(corrected.data?.replayed).toBe(false);
  });

  it('revalidates global, client, Pro, token, and connection authority inside apply', async () => {
    const authorization = await createWriteAuthorization();
    const baseInput: PlanCreateInput = {
      operationId: crypto.randomUUID(),
      title: 'Authorization barrier',
      startAt: at(13 * 60 * 60_000),
      endAt: at(14 * 60 * 60_000),
    };

    await setMutationControl(false);
    try {
      const disabled = await applyPlan(authorization, baseInput);
      expect(disabled.error?.code).toBe('DM003');
    } finally {
      await setMutationControl(true);
    }

    await setClientWriteControl(false);
    try {
      const disabledClient = await applyPlan(authorization, {
        ...baseInput,
        operationId: crypto.randomUUID(),
      });
      expect(disabledClient.error?.code).toBe('DM003');
    } finally {
      await setClientWriteControl(true);
    }

    await admin.from('profiles').update({ subscription_status: 'free' }).eq('id', userId);
    try {
      const downgraded = await applyPlan(authorization, {
        ...baseInput,
        operationId: crypto.randomUUID(),
      });
      expect(downgraded.error?.code).toBe('DM005');
    } finally {
      await admin.from('profiles').update({ subscription_status: 'active' }).eq('id', userId);
    }

    await admin
      .from('oauth_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', authorization.accessTokenId);
    const revokedToken = await applyPlan(authorization, {
      ...baseInput,
      operationId: crypto.randomUUID(),
    });
    expect(revokedToken.error?.code).toBe('DM004');

    const revokedConnectionAuthorization = await createWriteAuthorization();
    const { error: revokeConnectionError } = await userClient.rpc('revoke_oauth_connection', {
      p_connection_id: revokedConnectionAuthorization.connectionId,
    });
    expect(revokeConnectionError).toBeNull();
    const revokedConnection = await applyPlan(revokedConnectionAuthorization, {
      ...baseInput,
      operationId: crypto.randomUUID(),
    });
    expect(revokedConnection.error?.code).toBe('DM004');

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    expect(planCount).toBe(0);
  });

  it('replays across reauthorization for the same user and client', async () => {
    const firstAuthorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const input: PlanCreateInput = {
      operationId,
      title: 'Reconnect replay',
      startAt: at(15 * 60 * 60_000),
      endAt: at(16 * 60 * 60_000),
    };
    const first = await applyPlan(firstAuthorization, input);
    expect(first.error).toBeNull();

    const secondAuthorization = await createWriteAuthorization();
    const replay = await applyPlan(secondAuthorization, input);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...first.data!, replayed: true });
  });

  it('eagerly expires an older-than-90-day receipt before reusing the operation ID', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const first = await applyPlan(authorization, {
      operationId,
      title: 'Expired receipt origin',
      startAt: at(17 * 60 * 60_000),
      endAt: at(18 * 60 * 60_000),
    });
    expect(first.error).toBeNull();

    const backdate = spawn(
      'psql',
      [
        ...psqlArgs(),
        '-c',
        `BEGIN; ALTER TABLE public.mcp_mutation_receipts DISABLE TRIGGER trigger_enforce_mcp_mutation_receipt_lifecycle; UPDATE public.mcp_mutation_receipts SET applied_at = pg_catalog.clock_timestamp() - INTERVAL '91 days' WHERE user_id = '${userId}'::UUID AND operation_id = '${operationId}'::UUID; ALTER TABLE public.mcp_mutation_receipts ENABLE TRIGGER trigger_enforce_mcp_mutation_receipt_lifecycle; COMMIT;`,
      ],
      { env: psqlEnv() },
    );
    const [backdateCode] = (await once(backdate, 'close')) as [number];
    expect(backdateCode).toBe(0);

    const reused = await applyPlan(authorization, {
      operationId,
      title: 'New request after window',
      startAt: at(19 * 60 * 60_000),
      endAt: at(20 * 60 * 60_000),
    });
    expect(reused.error).toBeNull();
    expect(reused.data).toMatchObject({ replayed: false, operation_id: operationId });
    expect(reused.data?.resource_id).not.toBe(first.data?.resource_id);

    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(receiptCount).toBe(1);
  });

  it('rejects an apply whose token expires while waiting for the operation lock', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const holder = await holdOperationLock(userId, operationId);
    try {
      const expiresAt = new Date(Date.now() + 500).toISOString();
      const { error: expiryUpdateError } = await admin
        .from('oauth_tokens')
        .update({ expires_at: expiresAt })
        .eq('id', authorization.accessTokenId);
      expect(expiryUpdateError).toBeNull();

      const apply = Promise.resolve(
        applyPlan(authorization, {
          operationId,
          title: 'Expires while queued',
          startAt: at(21 * 60 * 60_000),
          endAt: at(22 * 60 * 60_000),
        }),
      );
      await waitForAdvisoryWaiter();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await holder.release();

      const result = await apply;
      expect(result.error?.code).toBe('DM004');
    } finally {
      await holder.release();
    }

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('operation_id', operationId);
    expect(planCount).toBe(0);
    expect(receiptCount).toBe(0);
  });

  it('locks the auth user parent first so account deletion cannot deadlock apply', async () => {
    const deleteUserId = crypto.randomUUID();
    const deleteEmail = `mcp-plan-delete-race-${deleteUserId}@example.com`;
    const operationId = crypto.randomUUID();
    const { error: createError } = await admin.auth.admin.createUser({
      id: deleteUserId,
      email: deleteEmail,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    await admin.from('profiles').update({ subscription_status: 'active' }).eq('id', deleteUserId);
    const authorization = await createWriteAuthorization(deleteUserId);
    const holder = await holdOperationLock(deleteUserId, operationId);

    try {
      const apply = Promise.resolve(
        applyPlan(authorization, {
          operationId,
          title: 'Apply before account delete',
          startAt: at(23 * 60 * 60_000),
          endAt: at(24 * 60 * 60_000),
        }),
      );
      await waitForAdvisoryWaiter();

      const deletion = admin.auth.admin.deleteUser(deleteUserId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await holder.release();

      const [applyResult, deleteResult] = await Promise.all([apply, deletion]);
      expect(applyResult.error).toBeNull();
      expect(deleteResult.error).toBeNull();
    } finally {
      await holder.release();
      await admin.auth.admin.deleteUser(deleteUserId);
    }

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', deleteUserId);
    const { count: receiptCount } = await admin
      .from('mcp_mutation_receipts')
      .select('operation_id', { count: 'exact', head: true })
      .eq('user_id', deleteUserId);
    expect(planCount).toBe(0);
    expect(receiptCount).toBe(0);
  });

  it('does not expose the typed apply RPC to authenticated clients', async () => {
    const authorization = await createWriteAuthorization();
    const { error } = await userClient.rpc('apply_mcp_plan_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: crypto.randomUUID(),
      p_title: 'Forbidden browser apply',
      p_note: dbNull,
      p_start_at: at(25 * 60 * 60_000),
      p_end_at: at(26 * 60 * 60_000),
    });
    expect(error?.code).toBe('42501');
  });
});
