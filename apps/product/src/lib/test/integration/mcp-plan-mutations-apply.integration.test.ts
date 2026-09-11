import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
const email = `mcp-plan-mutations-${userId}@example.com`;
const password = 'test-password-123';
const resource = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));
const dbNull = null as never;

type PlanRow = Database['public']['Tables']['plans']['Row'];

interface WriteAuthorization {
  accessTokenId: string;
  connectionId: string;
}

interface PlanPatch {
  title?: string;
  note?: string | null;
  startAt?: string;
  endAt?: string;
}

interface LockHolder {
  process: ChildProcessWithoutNullStreams;
  release: () => Promise<void>;
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function asUtcZuluPreservingPrecision(instant: string): string {
  if (instant.endsWith('+00:00')) return `${instant.slice(0, -6)}Z`;
  if (instant.endsWith('Z')) return instant.replace(/Z$/, '+00:00');
  throw new Error(`Expected a UTC timestamptz: ${instant}`);
}

function sameMillisecondDifferentVersion(version: string): string {
  const normalized = version.endsWith('Z') ? version.replace(/Z$/, '+00:00') : version;
  const match = normalized.match(/^(.*?)(?:\.(\d{1,6}))?([+-]\d{2}:?\d{2})$/);
  if (!match) throw new Error(`Unexpected timestamptz: ${version}`);

  const [, whole, fraction = '', offset] = match;
  const micros = fraction.padEnd(6, '0');
  const finalDigit = micros.at(-1) === '9' ? '8' : '9';
  return `${whole}.${micros.slice(0, -1)}${finalDigit}${offset}`;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

async function startLockHolder(
  variables: Record<string, string>,
  statement: string,
): Promise<LockHolder> {
  const process = spawn('psql', psqlArgs(variables), { env: psqlEnv() });
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
    `BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims TO '{"role":"service_role"}'; ${statement} SELECT 'LOCKED';\n`,
  );

  const deadline = Date.now() + 5_000;
  while (!stdout.includes('LOCKED')) {
    if (process.exitCode !== null) throw new Error(`Lock holder exited: ${stderr}`);
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock: ${stderr}`);
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

function holdPlanLock(planId: string): Promise<LockHolder> {
  return startLockHolder(
    { plan_id: planId },
    "SELECT 1 FROM public.plans WHERE id = :'plan_id'::UUID FOR UPDATE;",
  );
}

function holdOverlappingPlan(input: { startAt: string; endAt: string }): Promise<LockHolder> {
  return startLockHolder(
    { user_id: userId, start_at: input.startAt, end_at: input.endAt },
    "SELECT public.create_plan_command_v1(:'user_id'::UUID, 'Lock holder', NULL, NULL, 'manual', :'start_at'::TIMESTAMPTZ, :'end_at'::TIMESTAMPTZ);",
  );
}

async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await new Promise<string>((resolve, reject) => {
      const process = spawn(
        'psql',
        [...psqlArgs(), '-c', 'SELECT count(*) FROM pg_locks WHERE NOT granted'],
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
  throw new Error('Timed out waiting for the apply transaction to block on a domain lock');
}

async function expireWhileBlocked<T>(
  holder: LockHolder,
  accessTokenId: string,
  startApply: () => PromiseLike<T>,
): Promise<T> {
  try {
    const expiresAt = new Date(Date.now() + 500).toISOString();
    const { error } = await admin
      .from('oauth_tokens')
      .update({ expires_at: expiresAt })
      .eq('id', accessTokenId);
    if (error) throw error;

    const result = Promise.resolve(startApply());
    await waitForLockWaiter();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await holder.release();
    return await result;
  } finally {
    await holder.release();
  }
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
  const { error } = await admin.rpc('set_mcp_client_write_control_v1', {
    p_client_id: 'chatgpt',
    p_enabled: enabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
}

async function setMutationControl(writesEnabled: boolean) {
  const current = await readMutationControl();
  const { error } = await admin.rpc('set_mcp_mutation_control_v1', {
    p_writes_enabled: writesEnabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
}

async function createWriteAuthorization(): Promise<WriteAuthorization> {
  const code = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: resource,
      p_scopes: ['read:entries', 'write:plans', 'delete:plans'],
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

async function createPlan(input: {
  title: string;
  note?: string | null;
  externalCalendarEventId?: string | null;
  source?: 'manual' | 'api' | 'external_calendar';
  startAt: string;
  endAt: string;
}): Promise<PlanRow> {
  const { data, error } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: input.title,
      p_note: (input.note ?? null) as never,
      p_external_calendar_event_id: (input.externalCalendarEventId ?? null) as never,
      p_source: input.source ?? 'manual',
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
  if (error) throw error;
  return data;
}

function uiUpdate(plan: PlanRow, title: string) {
  return admin
    .rpc('update_plan_command_v1', {
      p_user_id: userId,
      p_plan_id: plan.id,
      p_expected_updated_at: plan.updated_at,
      p_title: title,
      p_note: plan.note as never,
      p_external_calendar_event_id: plan.external_calendar_event_id as never,
      p_start_at: plan.start_at,
      p_end_at: plan.end_at,
    })
    .single();
}

function applyUpdate(
  authorization: WriteAuthorization,
  operationId: string,
  planId: string,
  expectedUpdatedAt: string,
  patch: PlanPatch,
) {
  const titlePresent = hasOwn(patch, 'title');
  const notePresent = hasOwn(patch, 'note');
  const startAtPresent = hasOwn(patch, 'startAt');
  const endAtPresent = hasOwn(patch, 'endAt');

  return admin
    .rpc('apply_mcp_plan_update_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_plan_id: planId,
      p_expected_updated_at: expectedUpdatedAt,
      p_title_present: titlePresent,
      p_title: (titlePresent ? patch.title : null) as never,
      p_note_present: notePresent,
      p_note: (notePresent ? patch.note : null) as never,
      p_start_at_present: startAtPresent,
      p_start_at: (startAtPresent ? patch.startAt : null) as never,
      p_end_at_present: endAtPresent,
      p_end_at: (endAtPresent ? patch.endAt : null) as never,
    })
    .single();
}

function applyCreate(
  authorization: WriteAuthorization,
  operationId: string,
  input: { title: string; startAt: string; endAt: string },
) {
  return admin
    .rpc('apply_mcp_plan_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_title: input.title,
      p_note: dbNull,
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
}

function applyDelete(
  authorization: WriteAuthorization,
  operationId: string,
  planId: string,
  expectedUpdatedAt: string,
) {
  return admin
    .rpc('apply_mcp_plan_delete_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_plan_id: planId,
      p_expected_updated_at: expectedUpdatedAt,
    })
    .single();
}

function applyRestore(
  authorization: WriteAuthorization,
  operationId: string,
  planId: string,
  expectedUpdatedAt: string,
) {
  return admin
    .rpc('apply_mcp_plan_restore_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_plan_id: planId,
      p_expected_updated_at: expectedUpdatedAt,
    })
    .single();
}

async function countReceipts(operationIds: string[]): Promise<number> {
  const { count, error } = await admin
    .from('mcp_mutation_receipts')
    .select('operation_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('operation_id', operationIds);
  if (error) throw error;
  return count ?? 0;
}

describe.skipIf(!RUN_LOCAL)('MCP Plan update, delete, and restore apply integration', () => {
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
    await admin.from('records').delete().eq('user_id', userId);
    await admin.from('plans').delete().eq('user_id', userId);
    await admin.from('external_calendar_events').delete().eq('user_id', userId);
  });

  afterAll(async () => {
    await setMutationControl(false);
    await setClientWriteControl(false);
    await userClient.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  it('applies a partial patch, clears explicit nullable fields, and preserves internal bindings', async () => {
    const authorization = await createWriteAuthorization();
    const preserveOperationId = crypto.randomUUID();
    const clearOperationId = crypto.randomUUID();
    const externalEventId = crypto.randomUUID();
    const startAt = at(60 * 60_000);
    const endAt = at(2 * 60 * 60_000);

    const { error: eventError } = await admin.from('external_calendar_events').insert({
      id: externalEventId,
      user_id: userId,
      provider: 'google',
      provider_calendar_id: `calendar-${externalEventId}`,
      provider_event_id: `event-${externalEventId}`,
      title: 'Calendar event',
      start_at: startAt,
      end_at: endAt,
      status: 'processed',
      last_synced_at: new Date().toISOString(),
    });
    expect(eventError).toBeNull();

    const plan = await createPlan({
      title: 'External original',
      note: 'Remove me',
      externalCalendarEventId: externalEventId,
      source: 'external_calendar',
      startAt,
      endAt,
    });
    const preserve = await applyUpdate(
      authorization,
      preserveOperationId,
      plan.id,
      plan.updated_at,
      {
        title: 'MCP title',
      },
    );

    expect(preserve.error).toBeNull();
    expect(preserve.data).toMatchObject({
      schema_version: 1,
      operation_id: preserveOperationId,
      resource_type: 'plan',
      resource_id: plan.id,
      deleted_at: null,
      replayed: false,
    });

    const { data: preserved, error: preservedError } = await admin
      .from('plans')
      .select('*')
      .eq('id', plan.id)
      .single();
    expect(preservedError).toBeNull();
    expect(preserved).toMatchObject({
      title: 'MCP title',
      note: 'Remove me',
      source: 'external_calendar',
      external_calendar_event_id: externalEventId,
      start_at: plan.start_at,
      end_at: plan.end_at,
      updated_at: preserve.data?.version,
    });

    const clear = await applyUpdate(
      authorization,
      clearOperationId,
      plan.id,
      preserve.data!.version,
      { note: null },
    );
    expect(clear.error).toBeNull();

    const { data: updated, error: updatedError } = await admin
      .from('plans')
      .select('*')
      .eq('id', plan.id)
      .single();
    expect(updatedError).toBeNull();
    expect(updated).toMatchObject({
      title: 'MCP title',
      note: null,
      source: 'external_calendar',
      external_calendar_event_id: externalEventId,
      start_at: plan.start_at,
      end_at: plan.end_at,
      updated_at: clear.data?.version,
    });

    const uiResult = await uiUpdate(updated!, 'UI after MCP');
    expect(uiResult.error).toBeNull();
    const replay = await applyUpdate(
      authorization,
      clearOperationId,
      plan.id,
      asUtcZuluPreservingPrecision(preserve.data!.version),
      { note: null },
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...clear.data!, replayed: true });

    const { data: current } = await admin.from('plans').select('title').eq('id', plan.id).single();
    expect(current?.title).toBe('UI after MCP');
  });

  it('rejects empty and non-canonical patches without writing receipts', async () => {
    const authorization = await createWriteAuthorization();
    const plan = await createPlan({
      title: 'Patch validation',
      startAt: at(3 * 60 * 60_000),
      endAt: at(4 * 60 * 60_000),
    });
    const emptyOperationId = crypto.randomUUID();
    const hiddenValueOperationId = crypto.randomUUID();

    const empty = await applyUpdate(authorization, emptyOperationId, plan.id, plan.updated_at, {});
    expect(empty.error?.code).toBe('22023');

    const hiddenValue = await admin
      .rpc('apply_mcp_plan_update_v1', {
        p_connection_id: authorization.connectionId,
        p_access_token_id: authorization.accessTokenId,
        p_operation_id: hiddenValueOperationId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
        p_title_present: false,
        p_title: 'Excluded from digest',
        p_note_present: true,
        p_note: 'Visible patch',
        p_start_at_present: false,
        p_start_at: dbNull,
        p_end_at_present: false,
        p_end_at: dbNull,
      })
      .single();
    expect(hiddenValue.error?.code).toBe('22023');
    expect(await countReceipts([emptyOperationId, hiddenValueOperationId])).toBe(0);
  });

  it('rejects cross-tool operation ID reuse before changing domain state', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createPlan({
      title: 'Cross-tool reuse',
      startAt: at(5 * 60 * 60_000),
      endAt: at(6 * 60 * 60_000),
    });
    const update = await applyUpdate(authorization, operationId, plan.id, plan.updated_at, {
      title: 'Updated once',
    });
    expect(update.error).toBeNull();

    const reused = await applyDelete(authorization, operationId, plan.id, update.data!.version);
    expect(reused.error?.code).toBe('DM006');
    expect(await countReceipts([operationId])).toBe(1);

    const { data: persisted } = await admin
      .from('plans')
      .select('title, deleted_at')
      .eq('id', plan.id)
      .single();
    expect(persisted).toEqual({ title: 'Updated once', deleted_at: null });
  });

  it('replays the historical delete receipt after the UI restores the Plan', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createPlan({
      title: 'Delete receipt',
      startAt: at(7 * 60 * 60_000),
      endAt: at(8 * 60 * 60_000),
    });
    const first = await applyDelete(authorization, operationId, plan.id, plan.updated_at);
    expect(first.error).toBeNull();
    expect(first.data?.deleted_at).not.toBeNull();

    const { data: restored, error: restoreError } = await admin
      .rpc('restore_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: first.data!.version,
      })
      .single();
    expect(restoreError).toBeNull();

    const replay = await applyDelete(
      authorization,
      operationId,
      plan.id,
      asUtcZuluPreservingPrecision(plan.updated_at),
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...first.data!, replayed: true });
    expect(restored?.deleted_at).toBeNull();

    const { data: current } = await admin
      .from('plans')
      .select('deleted_at, updated_at')
      .eq('id', plan.id)
      .single();
    expect(current).toEqual({ deleted_at: null, updated_at: restored!.updated_at });
  });

  it('replays the historical restore receipt after the UI deletes the Plan again', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createPlan({
      title: 'Restore receipt',
      startAt: at(9 * 60 * 60_000),
      endAt: at(10 * 60 * 60_000),
    });
    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();

    const first = await applyRestore(authorization, operationId, plan.id, deleted!.updated_at);
    expect(first.error).toBeNull();
    expect(first.data?.deleted_at).toBeNull();

    const { data: deletedAgain, error: deleteAgainError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: first.data!.version,
      })
      .single();
    expect(deleteAgainError).toBeNull();

    const replay = await applyRestore(
      authorization,
      operationId,
      plan.id,
      asUtcZuluPreservingPrecision(deleted!.updated_at),
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...first.data!, replayed: true });

    const { data: current } = await admin
      .from('plans')
      .select('deleted_at, updated_at')
      .eq('id', plan.id)
      .single();
    expect(current).toEqual({
      deleted_at: deletedAgain!.deleted_at,
      updated_at: deletedAgain!.updated_at,
    });
  });

  it('allows only one of MCP and UI same-version updates to succeed', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createPlan({
      title: 'Update race',
      startAt: at(11 * 60 * 60_000),
      endAt: at(12 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      applyUpdate(authorization, operationId, plan.id, plan.updated_at, { title: 'MCP writer' }),
      uiUpdate(plan, 'UI writer'),
    ]);
    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(attempts.filter(({ error }) => error?.code === 'DT002')).toHaveLength(1);
    expect(await countReceipts([operationId])).toBe(attempts[0].error ? 0 : 1);

    const { data: current } = await admin.from('plans').select('title').eq('id', plan.id).single();
    expect(['MCP writer', 'UI writer']).toContain(current?.title);
  });

  it('allows only one of an MCP update and UI delete from the same version', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createPlan({
      title: 'Update-delete race',
      startAt: at(13 * 60 * 60_000),
      endAt: at(14 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      applyUpdate(authorization, operationId, plan.id, plan.updated_at, { title: 'MCP update' }),
      admin
        .rpc('delete_plan_command_v1', {
          p_user_id: userId,
          p_plan_id: plan.id,
          p_expected_updated_at: plan.updated_at,
        })
        .single(),
    ]);
    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['DT001', 'DT002'].includes(error?.code ?? '')),
    ).toHaveLength(1);
    expect(await countReceipts([operationId])).toBe(attempts[0].error ? 0 : 1);

    const { data: current } = await admin
      .from('plans')
      .select('title, deleted_at')
      .eq('id', plan.id)
      .single();
    if (attempts[0].error) {
      expect(current?.deleted_at).not.toBeNull();
      expect(current?.title).toBe('Update-delete race');
    } else {
      expect(current).toEqual({ title: 'MCP update', deleted_at: null });
    }
  });

  it('allows either MCP restore or an overlapping UI create, never both', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const startAt = at(15 * 60 * 60_000);
    const endAt = at(16 * 60 * 60_000);
    const plan = await createPlan({ title: 'Restore race', startAt, endAt });
    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();

    const attempts = await Promise.all([
      applyRestore(authorization, operationId, plan.id, deleted!.updated_at),
      admin
        .rpc('create_plan_command_v1', {
          p_user_id: userId,
          p_title: 'UI competing Plan',
          p_note: dbNull,
          p_external_calendar_event_id: dbNull,
          p_source: 'manual',
          p_start_at: startAt,
          p_end_at: endAt,
        })
        .single(),
    ]);
    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);
    expect(await countReceipts([operationId])).toBe(attempts[0].error ? 0 : 1);

    const { count: activeCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('deleted_at', null);
    expect(activeCount).toBe(1);
  });

  it('keeps exact CAS failures receipt-free for update, delete, and restore', async () => {
    const authorization = await createWriteAuthorization();
    const plan = await createPlan({
      title: 'Stale operations',
      startAt: at(17 * 60 * 60_000),
      endAt: at(18 * 60 * 60_000),
    });
    const staleVersion = sameMillisecondDifferentVersion(plan.updated_at);
    const updateOperationId = crypto.randomUUID();
    const deleteOperationId = crypto.randomUUID();
    const restoreOperationId = crypto.randomUUID();

    const update = await applyUpdate(authorization, updateOperationId, plan.id, staleVersion, {
      title: 'Must not apply',
    });
    expect(update.error?.code).toBe('DT002');

    const deletion = await applyDelete(authorization, deleteOperationId, plan.id, staleVersion);
    expect(deletion.error?.code).toBe('DT002');

    const { data: uiDeleted, error: uiDeleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(uiDeleteError).toBeNull();
    const restoration = await applyRestore(
      authorization,
      restoreOperationId,
      plan.id,
      sameMillisecondDifferentVersion(uiDeleted!.updated_at),
    );
    expect(restoration.error?.code).toBe('DT002');
    expect(await countReceipts([updateOperationId, deleteOperationId, restoreOperationId])).toBe(0);
  });

  it('rolls back create when an exclusion wait crosses the authority deadline', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const startAt = at(21 * 60 * 60_000);
    const endAt = at(22 * 60 * 60_000);
    const holder = await holdOverlappingPlan({ startAt, endAt });

    const result = await expireWhileBlocked(holder, authorization.accessTokenId, () =>
      applyCreate(authorization, operationId, {
        title: 'Must roll back after overlap wait',
        startAt,
        endAt,
      }),
    );
    expect(result.error?.code).toBe('DM004');
    expect(await countReceipts([operationId])).toBe(0);

    const { count: planCount } = await admin
      .from('plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    expect(planCount).toBe(0);
  });

  it('rolls back update, delete, and restore when a Plan lock wait crosses authority expiry', async () => {
    const plan = await createPlan({
      title: 'Authority barrier',
      startAt: at(23 * 60 * 60_000),
      endAt: at(24 * 60 * 60_000),
    });
    const updateAuthorization = await createWriteAuthorization();
    const updateOperationId = crypto.randomUUID();
    const updateHolder = await holdPlanLock(plan.id);
    const update = await expireWhileBlocked(updateHolder, updateAuthorization.accessTokenId, () =>
      applyUpdate(updateAuthorization, updateOperationId, plan.id, plan.updated_at, {
        title: 'Expired update',
      }),
    );
    expect(update.error?.code).toBe('DM004');

    const deleteAuthorization = await createWriteAuthorization();
    const deleteOperationId = crypto.randomUUID();
    const deleteHolder = await holdPlanLock(plan.id);
    const deletion = await expireWhileBlocked(deleteHolder, deleteAuthorization.accessTokenId, () =>
      applyDelete(deleteAuthorization, deleteOperationId, plan.id, plan.updated_at),
    );
    expect(deletion.error?.code).toBe('DM004');

    const { data: uiDeleted, error: uiDeleteError } = await admin
      .rpc('delete_plan_command_v1', {
        p_user_id: userId,
        p_plan_id: plan.id,
        p_expected_updated_at: plan.updated_at,
      })
      .single();
    expect(uiDeleteError).toBeNull();

    const restoreAuthorization = await createWriteAuthorization();
    const restoreOperationId = crypto.randomUUID();
    const restoreHolder = await holdPlanLock(plan.id);
    const restoration = await expireWhileBlocked(
      restoreHolder,
      restoreAuthorization.accessTokenId,
      () => applyRestore(restoreAuthorization, restoreOperationId, plan.id, uiDeleted!.updated_at),
    );
    expect(restoration.error?.code).toBe('DM004');
    expect(await countReceipts([updateOperationId, deleteOperationId, restoreOperationId])).toBe(0);

    const { data: current } = await admin
      .from('plans')
      .select('title, deleted_at, updated_at')
      .eq('id', plan.id)
      .single();
    expect(current).toEqual({
      title: 'Authority barrier',
      deleted_at: uiDeleted!.deleted_at,
      updated_at: uiDeleted!.updated_at,
    });
  });

  it('allows past content and past time changes through the shared command', async () => {
    const authorization = await createWriteAuthorization();
    const plan = await createPlan({
      title: 'Soon past',
      startAt: at(-2_000),
      endAt: at(1_500),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const contentOperationId = crypto.randomUUID();
    const contentUpdate = await applyUpdate(
      authorization,
      contentOperationId,
      plan.id,
      plan.updated_at,
      { title: 'Past content is editable' },
    );
    expect(contentUpdate.error).toBeNull();

    const timeOperationId = crypto.randomUUID();
    const timeUpdate = await applyUpdate(
      authorization,
      timeOperationId,
      plan.id,
      contentUpdate.data!.version,
      { startAt: at(-3_000) },
    );
    expect(timeUpdate.error).toBeNull();
    expect(await countReceipts([contentOperationId, timeOperationId])).toBe(2);
  });

  it('does not expose any Plan apply RPC to authenticated clients', async () => {
    const authorization = await createWriteAuthorization();
    const plan = await createPlan({
      title: 'Forbidden browser apply',
      startAt: at(25 * 60 * 60_000),
      endAt: at(26 * 60 * 60_000),
    });
    const base = {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_plan_id: plan.id,
      p_expected_updated_at: plan.updated_at,
    };

    const update = await userClient.rpc('apply_mcp_plan_update_v1', {
      ...base,
      p_operation_id: crypto.randomUUID(),
      p_title_present: true,
      p_title: 'Forbidden',
      p_note_present: false,
      p_note: dbNull,
      p_start_at_present: false,
      p_start_at: dbNull,
      p_end_at_present: false,
      p_end_at: dbNull,
    });
    const deletion = await userClient.rpc('apply_mcp_plan_delete_v1', {
      ...base,
      p_operation_id: crypto.randomUUID(),
    });
    const restoration = await userClient.rpc('apply_mcp_plan_restore_v1', {
      ...base,
      p_operation_id: crypto.randomUUID(),
    });

    expect(update.error?.code).toBe('42501');
    expect(deletion.error?.code).toBe('42501');
    expect(restoration.error?.code).toBe('42501');
  });
});
