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
const email = `mcp-record-mutations-${userId}@example.com`;
const foreignUserId = crypto.randomUUID();
const foreignEmail = `mcp-record-foreign-${foreignUserId}@example.com`;
const password = 'test-password-123';
const resource = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));
const dbNull = null as never;

type PlanRow = Database['public']['Tables']['plans']['Row'];
type RecordRow = Database['public']['Tables']['records']['Row'];

interface WriteAuthorization {
  accessTokenId: string;
  connectionId: string;
}

interface RecordPatch {
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

function holdRecordLock(recordId: string): Promise<LockHolder> {
  return startLockHolder(
    { record_id: recordId },
    "SELECT 1 FROM public.records WHERE id = :'record_id'::UUID FOR UPDATE;",
  );
}

function holdOverlappingRecord(input: { startAt: string; endAt: string }): Promise<LockHolder> {
  return startLockHolder(
    { user_id: userId, start_at: input.startAt, end_at: input.endAt },
    "SELECT public.create_record_command_v1(:'user_id'::UUID, 'Lock holder', NULL, NULL, NULL, 'manual', :'start_at'::TIMESTAMPTZ, :'end_at'::TIMESTAMPTZ);",
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

async function createWriteAuthorization(
  scopes: Array<'write:records' | 'delete:records'> = ['write:records', 'delete:records'],
): Promise<WriteAuthorization> {
  const code = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: resource,
      p_scopes: ['read:entries', ...scopes],
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
  startAt: string;
  endAt: string;
}): Promise<PlanRow> {
  const { data, error } = await admin
    .rpc('create_plan_command_v1', {
      p_user_id: userId,
      p_title: input.title,
      p_note: dbNull,
      p_external_calendar_event_id: dbNull,
      p_source: 'manual',
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
  if (error) throw error;
  return data;
}

async function createCompletedPlan(title: string): Promise<PlanRow> {
  const plan = await createPlan({
    title,
    startAt: at(-2_000),
    endAt: at(500),
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  return plan;
}

async function createRecord(input: {
  title: string;
  note?: string | null;
  planId?: string | null;
  externalCalendarEventId?: string | null;
  source?: 'manual' | 'api' | 'external_calendar';
  startAt: string;
  endAt: string;
}): Promise<RecordRow> {
  const { data, error } = await admin
    .rpc('create_record_command_v1', {
      p_user_id: userId,
      p_title: input.title,
      p_note: (input.note ?? null) as never,
      p_plan_id: (input.planId ?? null) as never,
      p_external_calendar_event_id: (input.externalCalendarEventId ?? null) as never,
      p_source: input.source ?? 'manual',
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
  if (error) throw error;
  return data;
}

function uiUpdate(record: RecordRow, title: string) {
  return admin
    .rpc('update_record_command_v1', {
      p_user_id: userId,
      p_record_id: record.id,
      p_expected_updated_at: record.updated_at,
      p_title: title,
      p_note: record.note as never,
      p_plan_id: dbNull,
      p_external_calendar_event_id: record.external_calendar_event_id as never,
      p_start_at: record.start_at,
      p_end_at: record.end_at,
    })
    .single();
}

function applyCreate(
  authorization: WriteAuthorization,
  operationId: string,
  input: {
    title: string;
    note?: string | null;
    planId?: string | null;
    startAt: string;
    endAt: string;
  },
) {
  return admin
    .rpc('apply_mcp_record_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_title: input.title,
      p_note: (input.note ?? null) as never,
      p_plan_id: (input.planId ?? null) as never,
      p_start_at: input.startAt,
      p_end_at: input.endAt,
    })
    .single();
}

function insertHistoricalCreateReceipt(input: {
  authorization: WriteAuthorization;
  operationId: string;
  record: RecordRow;
  planId: string;
  title: string;
  startAt: string;
  endAt: string;
}) {
  execFileSync(
    'psql',
    psqlArgs({
      user_id: userId,
      connection_id: input.authorization.connectionId,
      operation_id: input.operationId,
      resource_id: input.record.id,
      resource_version: input.record.updated_at,
      plan_id: input.planId,
      title: input.title,
      start_at: input.startAt,
      end_at: input.endAt,
    }),
    {
      env: psqlEnv(),
      input: `INSERT INTO public.mcp_mutation_receipts (
        user_id, client_id, operation_id, origin_connection_id, envelope_version,
        tool_name, request_digest, resource_type, resource_id, resource_version
      )
      SELECT
        :'user_id'::UUID, connection.client_id, :'operation_id'::UUID,
        :'connection_id'::UUID, 1, 'records.create',
        private.digest_mcp_mutation_envelope_v1(
          'records.create',
          pg_catalog.jsonb_build_object(
            'title', :'title'::TEXT,
            'note', NULL::TEXT,
            'tagId', NULL::UUID,
            'planId', :'plan_id'::UUID,
            'externalCalendarEventId', NULL::UUID,
            'source', 'api',
            'startAt', pg_catalog.to_char(:'start_at'::TIMESTAMPTZ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'endAt', pg_catalog.to_char(:'end_at'::TIMESTAMPTZ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          )
        ),
        'record', :'resource_id'::UUID, :'resource_version'::TIMESTAMPTZ
      FROM public.oauth_connections AS connection
      WHERE connection.id = :'connection_id'::UUID;`,
      stdio: 'pipe',
    },
  );
}

function applyUpdate(
  authorization: WriteAuthorization,
  operationId: string,
  recordId: string,
  expectedUpdatedAt: string,
  patch: RecordPatch,
) {
  const titlePresent = hasOwn(patch, 'title');
  const notePresent = hasOwn(patch, 'note');
  const startAtPresent = hasOwn(patch, 'startAt');
  const endAtPresent = hasOwn(patch, 'endAt');

  return admin
    .rpc('apply_mcp_record_update_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_record_id: recordId,
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

function applyDelete(
  authorization: WriteAuthorization,
  operationId: string,
  recordId: string,
  expectedUpdatedAt: string,
) {
  return admin
    .rpc('apply_mcp_record_delete_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_record_id: recordId,
      p_expected_updated_at: expectedUpdatedAt,
    })
    .single();
}

function applyRestore(
  authorization: WriteAuthorization,
  operationId: string,
  recordId: string,
  expectedUpdatedAt: string,
) {
  return admin
    .rpc('apply_mcp_record_restore_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: operationId,
      p_record_id: recordId,
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

describe.skipIf(!RUN_LOCAL)('MCP Record create, update, delete, and restore apply', () => {
  beforeAll(async () => {
    const { error: createError } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;

    const { error: foreignCreateError } = await admin.auth.admin.createUser({
      id: foreignUserId,
      email: foreignEmail,
      password,
      email_confirm: true,
    });
    if (foreignCreateError) throw foreignCreateError;

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
    await admin.from('records').delete().in('user_id', [userId, foreignUserId]);
    await admin.from('plans').delete().in('user_id', [userId, foreignUserId]);
    await admin.from('external_calendar_events').delete().eq('user_id', userId);
  });

  afterAll(async () => {
    await setMutationControl(false);
    await setClientWriteControl(false);
    await userClient.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
    await admin.auth.admin.deleteUser(foreignUserId);
  });

  it('creates independent api Records and replays historical success', async () => {
    const authorization = await createWriteAuthorization();
    const standaloneOperationId = crypto.randomUUID();
    const linkedOperationId = crypto.randomUUID();
    const standalone = await applyCreate(authorization, standaloneOperationId, {
      title: 'Standalone actual',
      startAt: at(-8 * 60 * 60_000),
      endAt: at(-7 * 60 * 60_000),
    });
    expect(standalone.error).toBeNull();
    expect(standalone.data).toMatchObject({
      schema_version: 1,
      operation_id: standaloneOperationId,
      resource_type: 'record',
      deleted_at: null,
      replayed: false,
    });

    const plan = await createCompletedPlan('Track target');
    const linkedInput = {
      title: 'Linked actual',
      startAt: at(-6 * 60 * 60_000),
      endAt: at(-5 * 60 * 60_000),
    };
    const historicalRecord = await createRecord({
      ...linkedInput,
      planId: plan.id,
      source: 'api',
    });
    insertHistoricalCreateReceipt({
      authorization,
      operationId: linkedOperationId,
      record: historicalRecord,
      planId: plan.id,
      ...linkedInput,
    });

    const linked = await applyCreate(authorization, linkedOperationId, {
      ...linkedInput,
      planId: plan.id,
    });
    expect(linked.error).toBeNull();
    expect(linked.data).toMatchObject({
      resource_id: historicalRecord.id,
      replayed: true,
    });

    const { data: persisted } = await admin
      .from('records')
      .select('source, external_calendar_event_id, deleted_at')
      .eq('id', linked.data!.resource_id)
      .single();
    expect(persisted).toEqual({
      source: 'api',
      external_calendar_event_id: null,
      deleted_at: null,
    });

    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: linked.data!.resource_id,
        p_expected_updated_at: linked.data!.version,
      })
      .single();
    expect(deleteError).toBeNull();
    const replay = await applyCreate(authorization, linkedOperationId, {
      ...linkedInput,
      planId: plan.id,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...linked.data!, replayed: true });
    expect(deleted?.deleted_at).not.toBeNull();
    const { data: afterReplay } = await admin
      .from('records')
      .select('id, deleted_at')
      .eq('id', linked.data!.resource_id);
    expect(afterReplay).toEqual([
      { id: linked.data!.resource_id, deleted_at: deleted!.deleted_at },
    ]);
    const { count: sameRangeCount } = await admin
      .from('records')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('start_at', linkedInput.startAt)
      .eq('end_at', linkedInput.endAt);
    expect(sameRangeCount).toBe(1);
  });

  it('applies partial updates while preserving external provenance', async () => {
    const authorization = await createWriteAuthorization();
    const externalEventId = crypto.randomUUID();
    const startAt = at(-12 * 60 * 60_000);
    const endAt = at(-11 * 60 * 60_000);
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
    await createCompletedPlan('Independent comparison');

    const record = await createRecord({
      title: 'External original',
      note: 'Remove me',
      externalCalendarEventId: externalEventId,
      source: 'external_calendar',
      startAt,
      endAt,
    });
    const firstOperationId = crypto.randomUUID();
    const first = await applyUpdate(authorization, firstOperationId, record.id, record.updated_at, {
      title: 'MCP correction',
    });
    expect(first.error).toBeNull();

    const { data: preserved } = await admin
      .from('records')
      .select('*')
      .eq('id', record.id)
      .single();
    expect(preserved).toMatchObject({
      title: 'MCP correction',
      note: 'Remove me',
      source: 'external_calendar',
      external_calendar_event_id: externalEventId,
      start_at: record.start_at,
      end_at: record.end_at,
    });

    const clearOperationId = crypto.randomUUID();
    const cleared = await applyUpdate(
      authorization,
      clearOperationId,
      record.id,
      first.data!.version,
      { note: null },
    );
    expect(cleared.error).toBeNull();

    const { data: current } = await admin.from('records').select('*').eq('id', record.id).single();
    expect(current).toMatchObject({
      note: null,
      source: 'external_calendar',
      external_calendar_event_id: externalEventId,
    });

    const uiResult = await uiUpdate(current!, 'UI after MCP');
    expect(uiResult.error).toBeNull();
    const replay = await applyUpdate(
      authorization,
      clearOperationId,
      record.id,
      asUtcZuluPreservingPrecision(first.data!.version),
      { note: null },
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...cleared.data!, replayed: true });
    const { data: afterReplay } = await admin
      .from('records')
      .select('title')
      .eq('id', record.id)
      .single();
    expect(afterReplay).toEqual({ title: 'UI after MCP' });
  });

  it('rejects empty/non-canonical patches and cross-tool operation reuse without receipts', async () => {
    const authorization = await createWriteAuthorization();
    const record = await createRecord({
      title: 'Patch validation',
      startAt: at(-10 * 60 * 60_000),
      endAt: at(-9 * 60 * 60_000),
    });
    const emptyOperationId = crypto.randomUUID();
    const hiddenOperationId = crypto.randomUUID();
    const reusedOperationId = crypto.randomUUID();

    const empty = await applyUpdate(
      authorization,
      emptyOperationId,
      record.id,
      record.updated_at,
      {},
    );
    expect(empty.error?.code).toBe('22023');
    const hidden = await admin
      .rpc('apply_mcp_record_update_v1', {
        p_connection_id: authorization.connectionId,
        p_access_token_id: authorization.accessTokenId,
        p_operation_id: hiddenOperationId,
        p_record_id: record.id,
        p_expected_updated_at: record.updated_at,
        p_title_present: false,
        p_title: 'Excluded from digest',
        p_note_present: true,
        p_note: 'Visible',
        p_start_at_present: false,
        p_start_at: dbNull,
        p_end_at_present: false,
        p_end_at: dbNull,
      })
      .single();
    expect(hidden.error?.code).toBe('22023');

    const update = await applyUpdate(
      authorization,
      reusedOperationId,
      record.id,
      record.updated_at,
      { title: 'Updated once' },
    );
    expect(update.error).toBeNull();
    const reused = await applyDelete(
      authorization,
      reusedOperationId,
      record.id,
      update.data!.version,
    );
    expect(reused.error?.code).toBe('DM006');
    expect(await countReceipts([emptyOperationId, hiddenOperationId, reusedOperationId])).toBe(1);
  });

  it('replays historical delete and restore receipts without changing current state', async () => {
    const authorization = await createWriteAuthorization();
    const record = await createRecord({
      title: 'Historical receipts',
      startAt: at(-14 * 60 * 60_000),
      endAt: at(-13 * 60 * 60_000),
    });
    const deleteOperationId = crypto.randomUUID();
    const firstDelete = await applyDelete(
      authorization,
      deleteOperationId,
      record.id,
      record.updated_at,
    );
    expect(firstDelete.error).toBeNull();
    expect(firstDelete.data?.deleted_at).not.toBeNull();

    const { data: uiRestored, error: restoreError } = await admin
      .rpc('restore_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: firstDelete.data!.version,
      })
      .single();
    expect(restoreError).toBeNull();
    const deleteReplay = await applyDelete(
      authorization,
      deleteOperationId,
      record.id,
      asUtcZuluPreservingPrecision(record.updated_at),
    );
    expect(deleteReplay.data).toEqual({ ...firstDelete.data!, replayed: true });

    const { data: uiDeleted, error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: uiRestored!.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();
    const restoreOperationId = crypto.randomUUID();
    const firstRestore = await applyRestore(
      authorization,
      restoreOperationId,
      record.id,
      uiDeleted!.updated_at,
    );
    expect(firstRestore.error).toBeNull();
    const { data: deletedAgain, error: deleteAgainError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: firstRestore.data!.version,
      })
      .single();
    expect(deleteAgainError).toBeNull();
    const restoreReplay = await applyRestore(
      authorization,
      restoreOperationId,
      record.id,
      asUtcZuluPreservingPrecision(uiDeleted!.updated_at),
    );
    expect(restoreReplay.data).toEqual({ ...firstRestore.data!, replayed: true });

    const { data: current } = await admin
      .from('records')
      .select('deleted_at, updated_at')
      .eq('id', record.id)
      .single();
    expect(current).toEqual({
      deleted_at: deletedAgain!.deleted_at,
      updated_at: deletedAgain!.updated_at,
    });
  });

  it('allows only one same-version Record update across MCP and UI', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const record = await createRecord({
      title: 'Update race',
      startAt: at(-16 * 60 * 60_000),
      endAt: at(-15 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      applyUpdate(authorization, operationId, record.id, record.updated_at, {
        title: 'MCP writer',
      }),
      uiUpdate(record, 'UI writer'),
    ]);
    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(attempts.filter(({ error }) => error?.code === 'DT002')).toHaveLength(1);
    expect(await countReceipts([operationId])).toBe(attempts[0].error ? 0 : 1);
  });

  it('allows only one same-version MCP update or UI delete', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const record = await createRecord({
      title: 'Update-delete race',
      startAt: at(-18 * 60 * 60_000),
      endAt: at(-17 * 60 * 60_000),
    });

    const attempts = await Promise.all([
      applyUpdate(authorization, operationId, record.id, record.updated_at, {
        title: 'MCP update',
      }),
      admin
        .rpc('delete_record_command_v1', {
          p_user_id: userId,
          p_record_id: record.id,
          p_expected_updated_at: record.updated_at,
        })
        .single(),
    ]);
    expect(attempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      attempts.filter(({ error }) => ['DT001', 'DT002'].includes(error?.code ?? '')),
    ).toHaveLength(1);
    expect(await countReceipts([operationId])).toBe(attempts[0].error ? 0 : 1);
  });

  it('allows either MCP create/restore or a competing UI Record, never both', async () => {
    const authorization = await createWriteAuthorization();
    const createOperationId = crypto.randomUUID();
    const createStart = at(-22 * 60 * 60_000);
    const createEnd = at(-21 * 60 * 60_000);
    const createAttempts = await Promise.all([
      applyCreate(authorization, createOperationId, {
        title: 'MCP create',
        startAt: createStart,
        endAt: createEnd,
      }),
      // 通常 UI の write は Candidate 6 以降 service-owned command boundary を通る
      // （authenticated の直接 DML は剥がした）
      createRecord({ title: 'UI create', startAt: createStart, endAt: createEnd })
        .then((data) => ({ data, error: null }))
        .catch((error: { code?: string }) => ({ data: null, error })),
    ]);
    expect(createAttempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      createAttempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);
    expect(await countReceipts([createOperationId])).toBe(createAttempts[0].error ? 0 : 1);

    await admin.from('records').delete().eq('user_id', userId);
    const restoreStart = at(-20 * 60 * 60_000);
    const restoreEnd = at(-19 * 60 * 60_000);
    const record = await createRecord({
      title: 'Restore race',
      startAt: restoreStart,
      endAt: restoreEnd,
    });
    const { data: deleted, error: deleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: record.updated_at,
      })
      .single();
    expect(deleteError).toBeNull();
    const restoreOperationId = crypto.randomUUID();
    const restoreAttempts = await Promise.all([
      applyRestore(authorization, restoreOperationId, record.id, deleted!.updated_at),
      createRecord({ title: 'UI competing create', startAt: restoreStart, endAt: restoreEnd })
        .then((data) => ({ data, error: null }))
        .catch((error: { code?: string }) => ({ data: null, error })),
    ]);
    expect(restoreAttempts.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      restoreAttempts.filter(({ error }) => ['23P01', '40P01'].includes(error?.code ?? '')),
    ).toHaveLength(1);

    const { count: activeCount } = await admin
      .from('records')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('deleted_at', null);
    expect(activeCount).toBe(1);
  });

  it('rejects retired link input without a receipt or a Plan mutation', async () => {
    const authorization = await createWriteAuthorization();
    const operationId = crypto.randomUUID();
    const plan = await createCompletedPlan('Retired link');
    const result = await applyCreate(authorization, operationId, {
      title: 'Old input',
      planId: plan.id,
      startAt: plan.start_at,
      endAt: plan.end_at,
    });
    expect(result.error?.code).toBe('DT012');
    expect(await countReceipts([operationId])).toBe(0);
    const { data } = await admin.from('plans').select('*').eq('id', plan.id).single();
    expect(data).toEqual(plan);
  });

  it('keeps exact CAS failures receipt-free and rejects immutable migrated Records', async () => {
    const authorization = await createWriteAuthorization();
    const record = await createRecord({
      title: 'Stale operations',
      startAt: at(-24 * 60 * 60_000),
      endAt: at(-23 * 60 * 60_000),
    });
    const stale = sameMillisecondDifferentVersion(record.updated_at);
    const updateOperationId = crypto.randomUUID();
    const deleteOperationId = crypto.randomUUID();
    const restoreOperationId = crypto.randomUUID();
    const update = await applyUpdate(authorization, updateOperationId, record.id, stale, {
      title: 'Must not apply',
    });
    const deletion = await applyDelete(authorization, deleteOperationId, record.id, stale);
    expect(update.error?.code).toBe('DT002');
    expect(deletion.error?.code).toBe('DT002');
    const { data: staleDeleted, error: staleDeleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: record.updated_at,
      })
      .single();
    expect(staleDeleteError).toBeNull();
    const restoration = await applyRestore(
      authorization,
      restoreOperationId,
      record.id,
      sameMillisecondDifferentVersion(staleDeleted!.updated_at),
    );
    expect(restoration.error?.code).toBe('DT002');

    const migratedId = crypto.randomUUID();
    const { data: migrated, error: migratedError } = await admin
      .from('records')
      .insert({
        id: migratedId,
        user_id: userId,
        title: 'Legacy import',
        source: 'auto_migrated',
        start_at: at(-26 * 60 * 60_000),
        end_at: at(-25 * 60 * 60_000),
      })
      .select('*')
      .single();
    expect(migratedError).toBeNull();
    const migratedUpdateId = crypto.randomUUID();
    const migratedDeleteId = crypto.randomUUID();
    const migratedRestoreId = crypto.randomUUID();
    const forbiddenUpdate = await applyUpdate(
      authorization,
      migratedUpdateId,
      migratedId,
      migrated!.updated_at,
      { title: 'Forbidden' },
    );
    const forbiddenDelete = await applyDelete(
      authorization,
      migratedDeleteId,
      migratedId,
      migrated!.updated_at,
    );
    expect(forbiddenUpdate.error?.code).toBe('DT009');
    expect(forbiddenDelete.error?.code).toBe('DT009');
    const { data: migratedDeleted, error: migratedDirectDeleteError } = await admin
      .from('records')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', migratedId)
      .select('*')
      .single();
    expect(migratedDirectDeleteError).toBeNull();
    const forbiddenRestore = await applyRestore(
      authorization,
      migratedRestoreId,
      migratedId,
      migratedDeleted!.updated_at,
    );
    expect(forbiddenRestore.error?.code).toBe('DT009');
    expect(
      await countReceipts([
        updateOperationId,
        deleteOperationId,
        restoreOperationId,
        migratedUpdateId,
        migratedDeleteId,
        migratedRestoreId,
      ]),
    ).toBe(0);
  });

  it('enforces current scope and hides foreign or unknown Record identity', async () => {
    const authorization = await createWriteAuthorization();
    const writeOnly = await createWriteAuthorization(['write:records']);
    const deleteOnly = await createWriteAuthorization(['delete:records']);
    const record = await createRecord({
      title: 'Scope target',
      startAt: at(-28 * 60 * 60_000),
      endAt: at(-27 * 60 * 60_000),
    });

    const deleteWithoutScope = await applyDelete(
      writeOnly,
      crypto.randomUUID(),
      record.id,
      record.updated_at,
    );
    const createWithoutScope = await applyCreate(deleteOnly, crypto.randomUUID(), {
      title: 'Forbidden create',
      startAt: at(-30 * 60 * 60_000),
      endAt: at(-29 * 60 * 60_000),
    });
    const unknownOperationId = crypto.randomUUID();
    const unknown = await applyUpdate(
      writeOnly,
      unknownOperationId,
      crypto.randomUUID(),
      record.updated_at,
      { title: 'Unknown target' },
    );
    expect(deleteWithoutScope.error?.code).toBe('DM004');
    expect(createWithoutScope.error?.code).toBe('DM004');
    expect(unknown.error?.code).toBe('DT001');

    const futurePlan = await createPlan({
      title: 'Recordable even while upcoming',
      startAt: at(3 * 60 * 60_000),
      endAt: at(4 * 60 * 60_000),
    });
    const futurePlanOperationId = crypto.randomUUID();
    const futurePlanLink = await applyCreate(authorization, futurePlanOperationId, {
      title: 'Past Record with future Plan',
      planId: futurePlan.id,
      startAt: at(-44 * 60 * 60_000),
      endAt: at(-43 * 60 * 60_000),
    });
    // Plan の位置は Record の紐付けを制約しない。Record 自身が過去であればよい。
    expect(futurePlanLink.error?.code).toBe('DT012');

    const { data: foreignPlan, error: foreignPlanError } = await admin
      .rpc('create_plan_command_v1', {
        p_user_id: foreignUserId,
        p_title: 'Foreign Plan',
        p_note: dbNull,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(60 * 60_000),
        p_end_at: at(2 * 60 * 60_000),
      })
      .single();
    expect(foreignPlanError).toBeNull();
    const { data: foreignRecord, error: foreignRecordError } = await admin
      .rpc('create_record_command_v1', {
        p_user_id: foreignUserId,
        p_title: 'Foreign Record',
        p_note: dbNull,
        p_plan_id: dbNull,
        p_external_calendar_event_id: dbNull,
        p_source: 'manual',
        p_start_at: at(-40 * 60 * 60_000),
        p_end_at: at(-39 * 60 * 60_000),
      })
      .single();
    expect(foreignRecordError).toBeNull();

    const foreignCreateId = crypto.randomUUID();
    const foreignUpdateId = crypto.randomUUID();
    const foreignDeleteId = crypto.randomUUID();
    const foreignRestoreId = crypto.randomUUID();
    const foreignCreate = await applyCreate(authorization, foreignCreateId, {
      title: 'Cross-tenant link',
      planId: foreignPlan!.id,
      startAt: at(-42 * 60 * 60_000),
      endAt: at(-41 * 60 * 60_000),
    });
    const foreignUpdate = await applyUpdate(
      authorization,
      foreignUpdateId,
      foreignRecord!.id,
      foreignRecord!.updated_at,
      { title: 'Cross-tenant update' },
    );
    const foreignDelete = await applyDelete(
      authorization,
      foreignDeleteId,
      foreignRecord!.id,
      foreignRecord!.updated_at,
    );
    const { data: foreignDeleted, error: foreignOwnerDeleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: foreignUserId,
        p_record_id: foreignRecord!.id,
        p_expected_updated_at: foreignRecord!.updated_at,
      })
      .single();
    expect(foreignOwnerDeleteError).toBeNull();
    const foreignRestore = await applyRestore(
      authorization,
      foreignRestoreId,
      foreignRecord!.id,
      foreignDeleted!.updated_at,
    );

    expect(foreignCreate.error?.code).toBe('DT012');
    expect(foreignUpdate.error?.code).toBe('DT001');
    expect(foreignDelete.error?.code).toBe('DT001');
    expect(foreignRestore.error?.code).toBe('DT001');
    // 未来 Plan への紐付けは成功する側なので receipt が 1 件残る。
    expect(await countReceipts([futurePlanOperationId])).toBe(0);
    expect(
      await countReceipts([
        unknownOperationId,
        foreignCreateId,
        foreignUpdateId,
        foreignDeleteId,
        foreignRestoreId,
      ]),
    ).toBe(0);
  });

  it('rolls back all four operations when domain lock waits cross authority expiry', async () => {
    const createAuthorization = await createWriteAuthorization();
    const createOperationId = crypto.randomUUID();
    const startAt = at(-32 * 60 * 60_000);
    const endAt = at(-31 * 60 * 60_000);
    const overlapHolder = await holdOverlappingRecord({ startAt, endAt });
    const creation = await expireWhileBlocked(
      overlapHolder,
      createAuthorization.accessTokenId,
      () =>
        applyCreate(createAuthorization, createOperationId, {
          title: 'Expired create',
          startAt,
          endAt,
        }),
    );
    expect(creation.error?.code).toBe('DM004');

    const record = await createRecord({
      title: 'Authority barrier',
      startAt: at(-34 * 60 * 60_000),
      endAt: at(-33 * 60 * 60_000),
    });
    const updateAuthorization = await createWriteAuthorization();
    const updateOperationId = crypto.randomUUID();
    const updateHolder = await holdRecordLock(record.id);
    const update = await expireWhileBlocked(updateHolder, updateAuthorization.accessTokenId, () =>
      applyUpdate(updateAuthorization, updateOperationId, record.id, record.updated_at, {
        title: 'Expired update',
      }),
    );
    expect(update.error?.code).toBe('DM004');

    const deleteAuthorization = await createWriteAuthorization();
    const deleteOperationId = crypto.randomUUID();
    const deleteHolder = await holdRecordLock(record.id);
    const deletion = await expireWhileBlocked(deleteHolder, deleteAuthorization.accessTokenId, () =>
      applyDelete(deleteAuthorization, deleteOperationId, record.id, record.updated_at),
    );
    expect(deletion.error?.code).toBe('DM004');

    const { data: uiDeleted, error: uiDeleteError } = await admin
      .rpc('delete_record_command_v1', {
        p_user_id: userId,
        p_record_id: record.id,
        p_expected_updated_at: record.updated_at,
      })
      .single();
    expect(uiDeleteError).toBeNull();
    const restoreAuthorization = await createWriteAuthorization();
    const restoreOperationId = crypto.randomUUID();
    const restoreHolder = await holdRecordLock(record.id);
    const restoration = await expireWhileBlocked(
      restoreHolder,
      restoreAuthorization.accessTokenId,
      () =>
        applyRestore(restoreAuthorization, restoreOperationId, record.id, uiDeleted!.updated_at),
    );
    expect(restoration.error?.code).toBe('DM004');
    expect(
      await countReceipts([
        createOperationId,
        updateOperationId,
        deleteOperationId,
        restoreOperationId,
      ]),
    ).toBe(0);

    const { data: current } = await admin
      .from('records')
      .select('title, deleted_at, updated_at')
      .eq('id', record.id)
      .single();
    expect(current).toEqual({
      title: 'Authority barrier',
      deleted_at: uiDeleted!.deleted_at,
      updated_at: uiDeleted!.updated_at,
    });
  });

  it('does not expose any Record apply RPC to authenticated clients', async () => {
    const authorization = await createWriteAuthorization();
    const record = await createRecord({
      title: 'Forbidden browser apply',
      startAt: at(-36 * 60 * 60_000),
      endAt: at(-35 * 60 * 60_000),
    });
    const create = await userClient.rpc('apply_mcp_record_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: crypto.randomUUID(),
      p_title: 'Forbidden',
      p_note: dbNull,
      p_plan_id: dbNull,
      p_start_at: at(-38 * 60 * 60_000),
      p_end_at: at(-37 * 60 * 60_000),
    });
    const base = {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_record_id: record.id,
      p_expected_updated_at: record.updated_at,
    };
    const update = await userClient.rpc('apply_mcp_record_update_v1', {
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
    const deletion = await userClient.rpc('apply_mcp_record_delete_v1', {
      ...base,
      p_operation_id: crypto.randomUUID(),
    });
    const restoration = await userClient.rpc('apply_mcp_record_restore_v1', {
      ...base,
      p_operation_id: crypto.randomUUID(),
    });

    expect(create.error?.code).toBe('42501');
    expect(update.error?.code).toBe('42501');
    expect(deletion.error?.code).toBe('42501');
    expect(restoration.error?.code).toBe('42501');
  });
});
