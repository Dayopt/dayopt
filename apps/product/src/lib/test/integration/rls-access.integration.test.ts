import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// #2271。oauth_connections は service_role にも INSERT/DELETE の GRANT が無く
// （SECURITY DEFINER RPC 経由でしか書けない設計）、adminSupabase（PostgREST 経由）では
// fixture を seed/cleanup できない。mcp-stage1-writer-fence.integration.test.ts と同じ
// psql 直接実行パターンで postgres role（GRANT の外）から挿入・削除する。
const RAW_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
function runRawSql(sql: string): string {
  return execFileSync('psql', [RAW_DATABASE_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: sql,
  }).trim();
}

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SUPABASE_URL =
  process.env.USE_LOCAL_DB === 'true'
    ? LOCAL_DB_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_DB_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5Nn0.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const TEST_USER_A_ID = crypto.randomUUID();
const TEST_USER_B_ID = crypto.randomUUID();
const TEST_USER_B_PLAN_ID = crypto.randomUUID();
const TEST_USER_B_RECORD_ID = crypto.randomUUID();
const RPC_SOFT_DELETE_PLAN_ID = crypto.randomUUID();
const RPC_CONFIRM_PLAN_ID = crypto.randomUUID();
const RPC_RESTORE_PLAN_ID = crypto.randomUUID();
const RPC_SOFT_DELETE_RECORD_ID = crypto.randomUUID();
const RPC_RESTORE_RECORD_ID = crypto.randomUUID();
const RPC_AUTO_ACTIVE_RECORD_ID = crypto.randomUUID();
const RPC_AUTO_DELETED_RECORD_ID = crypto.randomUUID();
const RPC_COUNT_CODE_ID = crypto.randomUUID();
const RPC_USE_CODE_ID = crypto.randomUUID();
const RPC_COUNT_CODE_HASH = `rpc-count-${crypto.randomUUID()}`;
const RPC_USE_CODE_HASH = `rpc-use-${crypto.randomUUID()}`;
const CALENDAR_CONNECTION_ID = crypto.randomUUID();
const CALENDAR_CONNECTION_CALENDAR_ID = crypto.randomUUID();
/** calendar_connections で authenticated に GRANT SELECT されている列（migration 20260723233814 と対応） */
const CALENDAR_CONNECTION_GRANTED_COLUMNS = [
  'id',
  'user_id',
  'provider',
  'provider_account_email',
  'status',
  'last_synced_at',
  'last_sync_error',
  'created_at',
  'updated_at',
] as const;
/** authenticated から読めてはいけない列 */
const CALENDAR_CONNECTION_WITHHELD_COLUMNS = [
  'refresh_token_enc',
  'granted_scopes',
  'provider_account_id',
] as const;
const EXTERNAL_CALENDAR_EVENT_ID = crypto.randomUUID();
/** external_calendar_events で authenticated に GRANT SELECT されている列（migration 20260813120000 と対応） */
const EXTERNAL_CALENDAR_EVENT_GRANTED_COLUMNS = [
  'id',
  'user_id',
  'provider',
  'provider_calendar_id',
  'provider_event_id',
  'title',
  'calendar_name',
  'start_at',
  'end_at',
  'status',
  'dismissed_at',
  'last_synced_at',
  'connection_id',
  'created_at',
  'updated_at',
] as const;
const TEST_EMAIL_A = `test-rls-a-${TEST_USER_A_ID}@example.com`;
const TEST_EMAIL_B = `test-rls-b-${TEST_USER_B_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';
// 他の integration suite と同じ gate を使う。`SKIP_INTEGRATION_TESTS` は repo の
// どこにも設定されておらず、この 5 ファイルだけが別 env を見ていた（#2647）。
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const ACCESS_DENIED_MESSAGE = 'Access denied: user_id mismatch';
const RPC_TIME_ANCHOR = Date.now();
const isoAtRpcOffset = (offsetMs: number) => new Date(RPC_TIME_ANCHOR + offsetMs).toISOString();
const TEST_USER_B_PLAN_START_AT = isoAtRpcOffset(24 * 60 * 60_000);
const TEST_USER_B_PLAN_END_AT = isoAtRpcOffset(25 * 60 * 60_000);
const RPC_SOFT_DELETE_PLAN_START_AT = isoAtRpcOffset(4 * 60 * 60_000);
const RPC_SOFT_DELETE_PLAN_END_AT = isoAtRpcOffset(5 * 60 * 60_000);
const RPC_RESTORE_PLAN_START_AT = isoAtRpcOffset(6 * 60 * 60_000);
const RPC_RESTORE_PLAN_END_AT = isoAtRpcOffset(7 * 60 * 60_000);
let rpcConfirmPlanStartAt = '';
let rpcConfirmPlanEndAt = '';
let rpcConfirmRangeStartAt = '';
let rpcConfirmRangeEndAt = '';
let rpcConfirmedAt = '';

const adminSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const supabaseA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const supabaseB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type UserOwnedRlsCase = {
  table: string;
  idColumn: string;
  rowId: string;
  seed: () => Promise<void>;
  update: Record<string, unknown>;
};

const userOwnedCases: UserOwnedRlsCase[] = [
  {
    table: 'profiles',
    idColumn: 'id',
    rowId: TEST_USER_B_ID,
    seed: async () => undefined,
    update: { full_name: 'foreign update' },
  },
  {
    table: 'plans',
    idColumn: 'id',
    rowId: TEST_USER_B_PLAN_ID,
    seed: async function () {
      const { error } = await adminSupabase.from('plans').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        title: 'RLS plan',
        source: 'manual',
        start_at: TEST_USER_B_PLAN_START_AT,
        end_at: TEST_USER_B_PLAN_END_AT,
      });
      if (error) throw error;
    },
    update: { title: 'foreign update' },
  },
  {
    table: 'records',
    idColumn: 'id',
    rowId: TEST_USER_B_RECORD_ID,
    seed: async function () {
      const { error } = await adminSupabase.from('records').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        title: 'RLS record',
        source: 'manual',
        start_at: '2026-06-15T11:00:00.000Z',
        end_at: '2026-06-15T12:00:00.000Z',
      });
      if (error) throw error;
    },
    update: { title: 'foreign update' },
  },
  {
    table: 'user_settings',
    idColumn: 'user_id',
    rowId: TEST_USER_B_ID,
    seed: async () => {
      const { error } = await adminSupabase
        .from('user_settings')
        .upsert({ user_id: TEST_USER_B_ID });
      if (error) throw error;
    },
    update: { theme: 'dark' },
  },
  {
    table: 'reports',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('reports').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        period_type: 'week',
        period_start: '2026-06-01',
        period_end: '2026-06-07',
        summary: 'RLS report',
        content: {},
      });
      if (error) throw error;
    },
    update: { summary: 'foreign update' },
  },
  {
    table: 'oauth_tokens',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('oauth_tokens').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        client_id: 'unknown',
        token_hash: `rls-${this.rowId}`,
        token_type: 'access',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      if (error) throw error;
    },
    update: { last_used_at: new Date().toISOString() },
  },
  {
    table: 'oauth_audit_log',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('oauth_audit_log').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        client_id: 'unknown',
        tool_name: 'rls_test',
      });
      if (error) throw error;
    },
    update: { tool_name: 'foreign_update' },
  },
  {
    // #2162 Step 1。E1 では matrix への登録が漏れていた（migration 内の privilege
    // invariant が production リスク自体は覆っているので、ここは防御層の補完）。
    table: 'categories',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('categories').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        name: `RLS category ${this.rowId}`,
      });
      if (error) throw error;
    },
    update: { name: 'foreign update' },
  },
  {
    // #2162 Step 1。同上。
    table: 'activities',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('activities').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        name: `RLS activity ${this.rowId}`,
      });
      if (error) throw error;
    },
    update: { name: 'foreign update' },
  },
  {
    // #2162 Step 5。service-role client の test（segment-schema / segments-service）は
    // 複合 FK を検証できるが RLS は素通りするため、実 anon client で見る場所がここになる。
    table: 'segments',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: async function () {
      const { error } = await adminSupabase.from('segments').insert({
        id: this.rowId,
        user_id: TEST_USER_B_ID,
        name: `RLS segment ${this.rowId}`,
      });
      if (error) throw error;
    },
    update: { name: 'foreign update' },
  },
];

/**
 * owner でも直接 mutation できず、service-owned な経路（typed RPC / command）だけが
 * 書けるユーザーデータ table。plans / records は Candidate 6 の ACL cutover で加わった。
 */
const SERVICE_OWNED_USER_TABLE_MUTATIONS = new Set([
  'oauth_tokens',
  'oauth_audit_log',
  'plans',
  'records',
]);

/**
 * 保存済みデータの削除は本人に残す一方、INSERT / UPDATE は課金判定を通る
 * service-owned writer に限定する table。共通 matrix では UPDATE の期待値だけが
 * SERVICE_OWNED_USER_TABLE_MUTATIONS と異なる。
 */
const SERVER_WRITE_OWNER_DELETE_TABLES = new Set(['activities', 'categories', 'segments']);
const SERVER_WRITE_OWNER_DELETE_CASES = ['activities', 'categories', 'segments'] as const;

const serviceRoleCases = [
  {
    table: 'stripe_webhook_events',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: {
      event_id: `evt_rls_${crypto.randomUUID()}`,
      event_type: 'test.event',
    },
    unauthorizedInsert: () => ({
      id: crypto.randomUUID(),
      event_id: `evt_rls_${crypto.randomUUID()}`,
      event_type: 'test.event',
    }),
    update: { event_type: 'foreign update' },
  },
  {
    table: 'email_suppressions',
    idColumn: 'id',
    rowId: crypto.randomUUID(),
    seed: {
      email: `rls-${crypto.randomUUID()}@example.com`,
      reason: 'bounce',
    },
    unauthorizedInsert: () => ({
      id: crypto.randomUUID(),
      email: `rls-${crypto.randomUUID()}@example.com`,
      reason: 'bounce',
    }),
    update: { reason: 'complaint' },
  },
  {
    table: 'oauth_authorization_codes',
    idColumn: 'code_hash',
    rowId: `rls-${crypto.randomUUID()}`,
    seed: {
      user_id: TEST_USER_B_ID,
      client_id: 'unknown',
      redirect_uri: 'https://example.com/oauth/callback',
      code_challenge: 'rls-code-challenge',
      code_challenge_method: 'S256',
      scopes: ['read:entries'],
    },
    unauthorizedInsert: () => ({
      code_hash: `rls-${crypto.randomUUID()}`,
      user_id: TEST_USER_A_ID,
      client_id: 'unknown',
      redirect_uri: 'https://example.com/oauth/callback',
      code_challenge: 'rls-code-challenge',
      code_challenge_method: 'S256',
      scopes: ['read:entries'],
    }),
    update: { consumed_at: new Date().toISOString() },
  },
];

async function createUser(id: string, email: string) {
  const { error } = await adminSupabase.auth.admin.createUser({
    id,
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
}

describe.skipIf(!RUN_LOCAL)('RLS access matrix', () => {
  beforeAll(async () => {
    await createUser(TEST_USER_A_ID, TEST_EMAIL_A);
    await createUser(TEST_USER_B_ID, TEST_EMAIL_B);

    const { error: signInErrorA } = await supabaseA.auth.signInWithPassword({
      email: TEST_EMAIL_A,
      password: TEST_PASSWORD,
    });
    if (signInErrorA) throw signInErrorA;

    const { error: signInErrorB } = await supabaseB.auth.signInWithPassword({
      email: TEST_EMAIL_B,
      password: TEST_PASSWORD,
    });
    if (signInErrorB) throw signInErrorB;

    for (const testCase of userOwnedCases) {
      await testCase.seed();
    }
    for (const testCase of serviceRoleCases) {
      const { error } = await adminSupabase
        .from(testCase.table)
        .insert({ [testCase.idColumn]: testCase.rowId, ...testCase.seed });
      if (error) throw error;
    }
  });

  afterAll(async () => {
    for (const testCase of serviceRoleCases) {
      await adminSupabase.from(testCase.table).delete().eq(testCase.idColumn, testCase.rowId);
    }
    for (const testCase of [...userOwnedCases].reverse()) {
      if (testCase.table !== 'profiles') {
        await adminSupabase.from(testCase.table).delete().eq(testCase.idColumn, testCase.rowId);
      }
    }
    await supabaseA.auth.signOut();
    await supabaseB.auth.signOut();
    await adminSupabase.auth.admin.deleteUser(TEST_USER_A_ID);
    await adminSupabase.auth.admin.deleteUser(TEST_USER_B_ID);
  });

  describe.each(userOwnedCases)('$table', (testCase) => {
    it('ownerは自分の行をselectできる', async () => {
      const { data, error } = await supabaseB
        .from(testCase.table)
        .select(testCase.idColumn)
        .eq(testCase.idColumn, testCase.rowId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it.each(['select', 'update', 'delete'] as const)(
      '他ユーザーの%sを拒否する',
      async (operation) => {
        let query = supabaseA
          .from(testCase.table)
          .select(testCase.idColumn)
          .eq(testCase.idColumn, testCase.rowId);
        if (operation === 'update') {
          query = supabaseA
            .from(testCase.table)
            .update(testCase.update)
            .eq(testCase.idColumn, testCase.rowId)
            .select();
        } else if (operation === 'delete') {
          query = supabaseA
            .from(testCase.table)
            .delete()
            .eq(testCase.idColumn, testCase.rowId)
            .select();
        }

        const { data, error } = await query;
        const isPrivilegeDeniedMutation =
          (operation !== 'select' && SERVICE_OWNED_USER_TABLE_MUTATIONS.has(testCase.table)) ||
          (operation === 'update' && SERVER_WRITE_OWNER_DELETE_TABLES.has(testCase.table)) ||
          (operation === 'delete' && testCase.table === 'profiles');
        if (isPrivilegeDeniedMutation) {
          expect(error?.code).toBe('42501');
          return;
        }
        expect(error).toBeNull();
        expect(data).toEqual([]);
      },
    );
  });

  it.each(SERVER_WRITE_OWNER_DELETE_CASES)(
    '$table はownerでも直接insert/updateを拒否し、select/deleteは許可する',
    async (table) => {
      const rowId = crypto.randomUUID();
      const row = { id: rowId, user_id: TEST_USER_B_ID, name: `RLS boundary ${rowId}` };

      const { error: directInsertError } = await supabaseB.from(table).insert(row);
      expect(directInsertError?.code).toBe('42501');

      const { error: serviceInsertError } = await adminSupabase.from(table).insert(row);
      expect(serviceInsertError).toBeNull();

      const { error: directUpdateError } = await supabaseB
        .from(table)
        .update({ name: 'forbidden direct update' })
        .eq('id', rowId);
      expect(directUpdateError?.code).toBe('42501');

      const { data: selected, error: selectError } = await supabaseB
        .from(table)
        .select('id')
        .eq('id', rowId);
      expect(selectError).toBeNull();
      expect(selected).toEqual([{ id: rowId }]);

      const { data: deleted, error: deleteError } = await supabaseB
        .from(table)
        .delete()
        .eq('id', rowId)
        .select('id');
      expect(deleteError).toBeNull();
      expect(deleted).toEqual([{ id: rowId }]);
    },
  );

  // Candidate 6: plans / records の authenticated 直接 DML を剥がし、SELECT だけ残した。
  // RLS policy は残っているが grant 層で到達不能になるため、insert/update/delete は
  // policy 評価より前に 42501 で落ちる。
  it('authenticatedはown Plan / Recordをreadできるが直接writeできない', async () => {
    const [planInsert, recordInsert, planUpdate, recordUpdate, planDelete, recordDelete] =
      await Promise.all([
        supabaseB.from('plans').insert({
          id: crypto.randomUUID(),
          user_id: TEST_USER_B_ID,
          title: 'Forbidden direct Plan',
          source: 'manual',
          start_at: isoAtRpcOffset(48 * 60 * 60_000),
          end_at: isoAtRpcOffset(49 * 60 * 60_000),
        }),
        supabaseB.from('records').insert({
          id: crypto.randomUUID(),
          user_id: TEST_USER_B_ID,
          title: 'Forbidden direct Record',
          source: 'manual',
          start_at: '2026-01-20T00:00:00.000Z',
          end_at: '2026-01-20T01:00:00.000Z',
        }),
        supabaseB
          .from('plans')
          .update({ title: 'Forbidden Plan update' })
          .eq('id', TEST_USER_B_PLAN_ID),
        supabaseB
          .from('records')
          .update({ title: 'Forbidden Record update' })
          .eq('id', TEST_USER_B_RECORD_ID),
        supabaseB.from('plans').delete().eq('id', TEST_USER_B_PLAN_ID),
        supabaseB.from('records').delete().eq('id', TEST_USER_B_RECORD_ID),
      ]);

    for (const result of [
      planInsert,
      recordInsert,
      planUpdate,
      recordUpdate,
      planDelete,
      recordDelete,
    ]) {
      expect(result.error?.code).toBe('42501');
    }

    const [{ data: plan, error: planReadError }, { data: record, error: recordReadError }] =
      await Promise.all([
        supabaseB.from('plans').select('title').eq('id', TEST_USER_B_PLAN_ID).single(),
        supabaseB.from('records').select('title').eq('id', TEST_USER_B_RECORD_ID).single(),
      ]);
    expect(planReadError).toBeNull();
    expect(recordReadError).toBeNull();
    expect(plan?.title).toBe('RLS plan');
    expect(record?.title).toBe('RLS record');
  });

  // #2618: MFA リカバリコードは「MFA を解除してよいか」の判断根拠なので、判断される当人
  // （authenticated）から読み書きできてはいけない。以前は自分の user_id なら INSERT でき、
  // 別アカウントで学んだ code_hash を被害者の行として植えることで MFA を迂回できた。
  // 詳細な境界は mfa-recovery-codes-lockdown.integration.test.ts が固定する。ここでは
  // 「owner でも到達できない table」として RLS マトリクスの側にも記録しておく。
  it('authenticatedはown recovery codeにも一切到達できない', async () => {
    const ownRowId = crypto.randomUUID();
    const { error: seedError } = await adminSupabase.from('mfa_recovery_codes').insert({
      id: ownRowId,
      user_id: TEST_USER_B_ID,
      code_hash: `rls-${ownRowId}`,
    });
    expect(seedError).toBeNull();

    const [select, insert, update, remove] = await Promise.all([
      supabaseB.from('mfa_recovery_codes').select('code_hash').eq('id', ownRowId),
      supabaseB
        .from('mfa_recovery_codes')
        .insert({ user_id: TEST_USER_B_ID, code_hash: 'forbidden-direct-insert' }),
      supabaseB
        .from('mfa_recovery_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', ownRowId),
      supabaseB.from('mfa_recovery_codes').delete().eq('id', ownRowId),
    ]);

    for (const result of [select, insert, update, remove]) {
      expect(result.error?.code).toBe('42501');
    }

    // service_role 側からは従来どおり読める（消費経路が壊れていないこと）。
    const { data: row, error: adminReadError } = await adminSupabase
      .from('mfa_recovery_codes')
      .select('code_hash')
      .eq('id', ownRowId)
      .single();
    expect(adminReadError).toBeNull();
    expect(row?.code_hash).toBe(`rls-${ownRowId}`);

    await adminSupabase.from('mfa_recovery_codes').delete().eq('id', ownRowId);
  });

  describe('profiles deletion grants', () => {
    it('ownerでもprofileを直接deleteできない', async () => {
      const { error } = await supabaseB
        .from('profiles')
        .delete()
        .eq('id', TEST_USER_B_ID)
        .select('id');

      expect(error?.code).toBe('42501');

      const { data: profile, error: profileError } = await adminSupabase
        .from('profiles')
        .select('id')
        .eq('id', TEST_USER_B_ID)
        .single();

      expect(profileError).toBeNull();
      expect(profile?.id).toBe(TEST_USER_B_ID);
    });
  });

  describe('OAuth token column grants', () => {
    it('ownerでもtoken_hash列は読めない', async () => {
      const tokenCase = userOwnedCases.find((testCase) => testCase.table === 'oauth_tokens');
      if (!tokenCase) throw new Error('oauth_tokens RLS fixture is missing');

      const { error } = await supabaseB
        .from('oauth_tokens')
        .select('token_hash')
        .eq('id', tokenCase.rowId);

      expect(error?.code).toBe('42501');
    });
  });

  describe('profiles billing column grants', () => {
    it('ownerでもbilling entitlement columnsを直接更新できない', async () => {
      const { error } = await supabaseB
        .from('profiles')
        .update({
          stripe_customer_id: `cus_forbidden_${crypto.randomUUID()}`,
          subscription_id: `sub_forbidden_${crypto.randomUUID()}`,
          subscription_status: 'active',
        })
        .eq('id', TEST_USER_B_ID);

      expect(error?.code).toBe('42501');

      const { data, error: readError } = await adminSupabase
        .from('profiles')
        .select('stripe_customer_id, subscription_id, subscription_status')
        .eq('id', TEST_USER_B_ID)
        .single();

      expect(readError).toBeNull();
      expect(data?.stripe_customer_id).toBeNull();
      expect(data?.subscription_id).toBeNull();
      expect(data?.subscription_status).toBe('free');
    });

    it('ownerはprofile presentation columnsを更新できる', async () => {
      const { error } = await supabaseB
        .from('profiles')
        .update({ full_name: 'RLS profile owner update', avatar_url: null })
        .eq('id', TEST_USER_B_ID);

      expect(error).toBeNull();
    });

    it('service_roleはStripe webhook経路としてbilling entitlement columnsを更新できる', async () => {
      const stripeCustomerId = `cus_allowed_${crypto.randomUUID()}`;
      const subscriptionId = `sub_allowed_${crypto.randomUUID()}`;

      const { error } = await adminSupabase
        .from('profiles')
        .update({
          stripe_customer_id: stripeCustomerId,
          subscription_id: subscriptionId,
          subscription_status: 'active',
        })
        .eq('id', TEST_USER_B_ID);

      expect(error).toBeNull();

      const { data, error: readError } = await adminSupabase
        .from('profiles')
        .select('stripe_customer_id, subscription_id, subscription_status')
        .eq('id', TEST_USER_B_ID)
        .single();

      expect(readError).toBeNull();
      expect(data).toMatchObject({
        stripe_customer_id: stripeCustomerId,
        subscription_id: subscriptionId,
        subscription_status: 'active',
      });

      const { error: resetError } = await adminSupabase
        .from('profiles')
        .update({
          stripe_customer_id: null,
          subscription_id: null,
          subscription_status: 'free',
        })
        .eq('id', TEST_USER_B_ID);

      expect(resetError).toBeNull();
    });
  });

  // calendar_connections は repo 初の column-scoped SELECT。userOwnedCases /
  // serviceRoleCases のどちらの共通ブロックにも当てはまらないため独立させる
  // （前者は select('*') と update/delete が error null を期待し、後者は
  // "No browser client access" policy の件数と結びついている）。
  //
  // production の pg_default_acl は新規 public テーブルに anon/authenticated へ
  // arwdDxtm を撒くが local は Dxtm しか撒かない。REVOKE 漏れは local 由来の
  // rls:snapshot では検出できないので、ここと migration 内の invariant が gate になる。
  describe('calendar connection column grants', () => {
    beforeAll(async () => {
      const { error: connectionError } = await adminSupabase.from('calendar_connections').insert({
        id: CALENDAR_CONNECTION_ID,
        user_id: TEST_USER_B_ID,
        provider: 'google',
        provider_account_id: `sub-${CALENDAR_CONNECTION_ID}`,
        provider_account_email: TEST_EMAIL_B,
        granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refresh_token_enc: 'rls-ciphertext',
        status: 'active',
      });
      if (connectionError) throw connectionError;

      const { error: calendarError } = await adminSupabase
        .from('calendar_connection_calendars')
        .insert({
          id: CALENDAR_CONNECTION_CALENDAR_ID,
          connection_id: CALENDAR_CONNECTION_ID,
          user_id: TEST_USER_B_ID,
          provider_calendar_id: 'primary',
          calendar_name: 'RLS calendar',
          sync_token: 'rls-sync-token',
        });
      if (calendarError) throw calendarError;
    });

    afterAll(async () => {
      // 子は複合 FK の ON DELETE CASCADE で消える
      await adminSupabase.from('calendar_connections').delete().eq('id', CALENDAR_CONNECTION_ID);
    });

    it('ownerはgrant済みの列だけを明示指定して自分の接続を読める', async () => {
      const { data, error } = await supabaseB
        .from('calendar_connections')
        .select(CALENDAR_CONNECTION_GRANTED_COLUMNS.join(', '))
        .eq('id', CALENDAR_CONNECTION_ID);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("ownerでもselect('*')は列権限で拒否される", async () => {
      const { error } = await supabaseB
        .from('calendar_connections')
        .select('*')
        .eq('id', CALENDAR_CONNECTION_ID);

      expect(error?.code).toBe('42501');
    });

    it.each(CALENDAR_CONNECTION_WITHHELD_COLUMNS)('ownerでも%s列は読めない', async (column) => {
      const { error } = await supabaseB
        .from('calendar_connections')
        .select(column)
        .eq('id', CALENDAR_CONNECTION_ID);

      expect(error?.code).toBe('42501');
    });

    it('未grant列をfilterに使うクエリも拒否される', async () => {
      const { error } = await supabaseB
        .from('calendar_connections')
        .select('id')
        .eq('provider_account_id', `sub-${CALENDAR_CONNECTION_ID}`);

      expect(error?.code).toBe('42501');
    });

    it('他ユーザーの接続はRLSで0件になる', async () => {
      const { data, error } = await supabaseA
        .from('calendar_connections')
        .select('id')
        .eq('id', CALENDAR_CONNECTION_ID);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it.each(['insert', 'update', 'delete'] as const)(
      'authenticated clientの%sを拒否する',
      async (operation) => {
        if (operation === 'insert') {
          const { error } = await supabaseB.from('calendar_connections').insert({
            user_id: TEST_USER_B_ID,
            provider: 'google',
            provider_account_id: `sub-forbidden-${crypto.randomUUID()}`,
            granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
            refresh_token_enc: 'forbidden',
            status: 'active',
          });
          expect(error?.code).toBe('42501');
          return;
        }

        const { error } =
          operation === 'update'
            ? await supabaseB
                .from('calendar_connections')
                .update({ status: 'reauth_required' })
                .eq('id', CALENDAR_CONNECTION_ID)
            : await supabaseB
                .from('calendar_connections')
                .delete()
                .eq('id', CALENDAR_CONNECTION_ID);

        expect(error?.code).toBe('42501');
      },
    );

    it('ownerは選択カレンダーをtable単位のSELECTで読める', async () => {
      const { data, error } = await supabaseB
        .from('calendar_connection_calendars')
        .select('*')
        .eq('id', CALENDAR_CONNECTION_CALENDAR_ID);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('他ユーザーの選択カレンダーはRLSで0件になる', async () => {
      const { data, error } = await supabaseA
        .from('calendar_connection_calendars')
        .select('id')
        .eq('id', CALENDAR_CONNECTION_CALENDAR_ID);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('authenticated clientは選択カレンダーを変更できない', async () => {
      const { error } = await supabaseB
        .from('calendar_connection_calendars')
        .update({ sync_token: 'forbidden' })
        .eq('id', CALENDAR_CONNECTION_CALENDAR_ID);

      expect(error?.code).toBe('42501');
    });

    // 複合 FK (connection_id, user_id) -> calendar_connections (id, user_id) の回帰テスト。
    // service_role は RLS を bypass するので、cross-user の取り違えを止めるのは FK だけ。
    // これが無いと Step 3 の sync / Step 7 の切断が他ユーザーのミラー行を巻き込む
    it('ミラー行に他ユーザーのconnectionをぶら下げられない', async () => {
      const { error } = await adminSupabase.from('external_calendar_events').insert({
        user_id: TEST_USER_A_ID,
        connection_id: CALENDAR_CONNECTION_ID, // user B の接続
        provider: 'google',
        provider_calendar_id: 'primary',
        provider_event_id: `evt-cross-${crypto.randomUUID()}`,
        title: 'cross-user link',
        start_at: '2026-06-20T09:00:00.000Z',
        end_at: '2026-06-20T10:00:00.000Z',
        status: 'confirmed',
        last_synced_at: new Date().toISOString(),
      });

      expect(error?.code).toBe('23503');
    });

    it('切断でミラー行のconnection_idだけがNULLになりuser_idは残る', async () => {
      const connectionId = crypto.randomUUID();
      const eventId = crypto.randomUUID();

      const { error: connectionError } = await adminSupabase.from('calendar_connections').insert({
        id: connectionId,
        user_id: TEST_USER_B_ID,
        provider: 'google',
        provider_account_id: `sub-${connectionId}`,
        granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refresh_token_enc: 'disconnect-ciphertext',
        status: 'active',
      });
      expect(connectionError).toBeNull();

      const { error: eventError } = await adminSupabase.from('external_calendar_events').insert({
        id: eventId,
        user_id: TEST_USER_B_ID,
        connection_id: connectionId,
        provider: 'google',
        provider_calendar_id: 'primary',
        provider_event_id: `evt-disconnect-${eventId}`,
        title: 'survives disconnect',
        start_at: '2026-06-21T09:00:00.000Z',
        end_at: '2026-06-21T10:00:00.000Z',
        status: 'confirmed',
        last_synced_at: new Date().toISOString(),
      });
      expect(eventError).toBeNull();

      const { error: deleteError } = await adminSupabase
        .from('calendar_connections')
        .delete()
        .eq('id', connectionId);
      expect(deleteError).toBeNull();

      const { data, error } = await adminSupabase
        .from('external_calendar_events')
        .select('connection_id, user_id')
        .eq('id', eventId)
        .single();

      expect(error).toBeNull();
      expect(data?.connection_id).toBeNull();
      expect(data?.user_id).toBe(TEST_USER_B_ID);

      await adminSupabase.from('external_calendar_events').delete().eq('id', eventId);
    });

    // service_role は rolbypassrls = t なので、これは policy ではなく GRANT の証明
    it('service_roleはtoken列を読める', async () => {
      const { data, error } = await adminSupabase
        .from('calendar_connections')
        .select('refresh_token_enc, granted_scopes, provider_account_id')
        .eq('id', CALENDAR_CONNECTION_ID)
        .single();

      expect(error).toBeNull();
      expect(data?.refresh_token_enc).toBe('rls-ciphertext');
    });
  });

  // #1992: description は risk-reviewer 指摘（PR #1991）を受けて column-scoped SELECT にした。
  // calendar_connections と同じ理由でここを独立させる（userOwnedCases / serviceRoleCases の
  // どちらの共通ブロックにも当てはまらない）。
  describe('external calendar event column grants', () => {
    beforeAll(async () => {
      const { error } = await adminSupabase.from('external_calendar_events').insert({
        id: EXTERNAL_CALENDAR_EVENT_ID,
        user_id: TEST_USER_A_ID,
        provider: 'google',
        provider_calendar_id: 'primary',
        provider_event_id: `evt-grant-${EXTERNAL_CALENDAR_EVENT_ID}`,
        title: 'grant column test',
        description: 'body text that must never reach a browser client',
        start_at: '2026-06-22T09:00:00.000Z',
        end_at: '2026-06-22T10:00:00.000Z',
        status: 'confirmed',
        last_synced_at: new Date().toISOString(),
      });
      if (error) throw error;
    });

    afterAll(async () => {
      await adminSupabase
        .from('external_calendar_events')
        .delete()
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID);
    });

    it('ownerはgrant済みの列だけを明示指定して自分のミラー行を読める', async () => {
      const { data, error } = await supabaseA
        .from('external_calendar_events')
        .select(EXTERNAL_CALENDAR_EVENT_GRANTED_COLUMNS.join(', '))
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("ownerでもselect('*')は列権限で拒否される", async () => {
      const { error } = await supabaseA
        .from('external_calendar_events')
        .select('*')
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID);

      expect(error?.code).toBe('42501');
    });

    it('ownerでもdescription列は読めない', async () => {
      const { error } = await supabaseA
        .from('external_calendar_events')
        .select('description')
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID);

      expect(error?.code).toBe('42501');
    });

    // service_role は rolbypassrls = t なので、これは policy ではなく GRANT の証明
    it('service_roleはdescription列を読める', async () => {
      const { data, error } = await adminSupabase
        .from('external_calendar_events')
        .select('description')
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID)
        .single();

      expect(error).toBeNull();
      expect(data?.description).toBe('body text that must never reach a browser client');
    });

    // #1984: dismissEvent は service_role を経由せず authenticated client で直接 UPDATE する。
    // ここで検証するのは migration 20260708232500 の GRANT UPDATE(dismissed_at) と
    // "Users can dismiss own external calendar events" policy の組み合わせそのもの。
    it('ownerは自分のdismissed_atを更新でき、nullへも戻せる', async () => {
      const { data: dismissed, error: dismissError } = await supabaseA
        .from('external_calendar_events')
        .update({ dismissed_at: '2026-06-22T09:30:00.000Z' })
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID)
        .eq('user_id', TEST_USER_A_ID)
        .select('dismissed_at');

      expect(dismissError).toBeNull();
      expect(dismissed).toHaveLength(1);
      // PostgREST は +00:00 offset で返す（Z suffix ではない）ため Date 比較する
      expect(new Date(dismissed?.[0]?.dismissed_at ?? '').toISOString()).toBe(
        '2026-06-22T09:30:00.000Z',
      );

      const { data: undone, error: undoError } = await supabaseA
        .from('external_calendar_events')
        .update({ dismissed_at: null })
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID)
        .eq('user_id', TEST_USER_A_ID)
        .select('dismissed_at');

      expect(undoError).toBeNull();
      expect(undone).toHaveLength(1);
      expect(undone?.[0]?.dismissed_at).toBeNull();
    });

    it('他ユーザーはdismissed_atを更新できない（RLSで0件）', async () => {
      const { data, error } = await supabaseB
        .from('external_calendar_events')
        .update({ dismissed_at: '2026-06-22T09:30:00.000Z' })
        .eq('id', EXTERNAL_CALENDAR_EVENT_ID)
        .select('dismissed_at');

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  // #2271。oauth_connections は authenticated に SELECT のみ GRANT（write は無 GRANT、
  // service_role にも INSERT/DELETE 権限が無い設計 — 本文書き込みは SECURITY DEFINER RPC
  // 経由のみ）。userOwnedCases の共通ブロックには乗らないため独立させ、fixture は
  // runRawSql（postgres role、GRANT の外）で seed/cleanup する。
  describe('oauth_connections column grants', () => {
    const OAUTH_CONNECTION_ID = crypto.randomUUID();
    // resource_uri は mcp_environment_identity への FK。ハードコードすると migration 側の
    // seed 値が変わった時に静かにズレるため、実際に seed 済みの値を都度問い合わせる。
    let environmentResourceUri = '';

    beforeAll(() => {
      environmentResourceUri = runRawSql(
        'SELECT resource_uri FROM public.mcp_environment_identity LIMIT 1;',
      );
      if (!environmentResourceUri) {
        throw new Error('mcp_environment_identity has no seeded resource_uri to reference');
      }
      runRawSql(`
        INSERT INTO public.oauth_connections
          (id, user_id, client_id, resource_uri, scopes)
        VALUES
          ('${OAUTH_CONNECTION_ID}', '${TEST_USER_B_ID}', 'unknown', '${environmentResourceUri}', ARRAY['read:entries']);
      `);
    });

    afterAll(() => {
      runRawSql(`DELETE FROM public.oauth_connections WHERE id = '${OAUTH_CONNECTION_ID}';`);
    });

    it('ownerは自分のconnectionをselectできる', async () => {
      const { data, error } = await supabaseB
        .from('oauth_connections')
        .select('id, client_id')
        .eq('id', OAUTH_CONNECTION_ID);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('他ユーザーの接続はRLSで0件になる', async () => {
      const { data, error } = await supabaseA
        .from('oauth_connections')
        .select('id')
        .eq('id', OAUTH_CONNECTION_ID);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it.each(['insert', 'update', 'delete'] as const)(
      'ownerでもauthenticatedの%sはwrite grantが無いため常に42501',
      async (operation) => {
        let query = supabaseB.from('oauth_connections').select();
        if (operation === 'insert') {
          query = supabaseB.from('oauth_connections').insert({
            user_id: TEST_USER_B_ID,
            client_id: 'unknown',
            resource_uri: 'https://example.com/mcp',
            scopes: ['read:entries'],
          });
        } else if (operation === 'update') {
          query = supabaseB
            .from('oauth_connections')
            .update({ legacy_read_only: true })
            .eq('id', OAUTH_CONNECTION_ID);
        } else if (operation === 'delete') {
          query = supabaseB.from('oauth_connections').delete().eq('id', OAUTH_CONNECTION_ID);
        }

        const { error } = await query;
        expect(error?.code).toBe('42501');
      },
    );
  });

  // segment_activities はINSERT/UPDATEをservice-owned writerへ限定し、SELECT/DELETEは
  // ownerに残すため、userOwnedCasesの共通ブロックとは権限集合が異なる。
  // segment_id / activity_id はuserOwnedCasesでseed済みの行を再利用する。
  describe('segment_activities cross-user isolation', () => {
    const segmentCase = userOwnedCases.find((c) => c.table === 'segments');
    const activityCase = userOwnedCases.find((c) => c.table === 'activities');
    if (!segmentCase || !activityCase) {
      throw new Error('segment_activities RLS fixture requires segments/activities cases');
    }

    afterAll(async () => {
      await adminSupabase
        .from('segment_activities')
        .delete()
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
    });

    it('ownerの直接insertは拒否し、service-role作成後はselect・deleteできる', async () => {
      const { error: insertError } = await supabaseB.from('segment_activities').insert({
        segment_id: segmentCase.rowId,
        activity_id: activityCase.rowId,
        user_id: TEST_USER_B_ID,
      });
      expect(insertError?.code).toBe('42501');

      const { error: serviceInsertError } = await adminSupabase.from('segment_activities').insert({
        segment_id: segmentCase.rowId,
        activity_id: activityCase.rowId,
        user_id: TEST_USER_B_ID,
      });
      expect(serviceInsertError).toBeNull();

      const { data, error: selectError } = await supabaseB
        .from('segment_activities')
        .select('segment_id, activity_id')
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
      expect(selectError).toBeNull();
      expect(data).toHaveLength(1);

      const { error: deleteError } = await supabaseB
        .from('segment_activities')
        .delete()
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
      expect(deleteError).toBeNull();

      // 以降のテストのため service-role で再挿入する
      const { error: reinsertError } = await adminSupabase.from('segment_activities').insert({
        segment_id: segmentCase.rowId,
        activity_id: activityCase.rowId,
        user_id: TEST_USER_B_ID,
      });
      expect(reinsertError).toBeNull();
    });

    it('他ユーザーはRLSで0件になり、insert/deleteも通らない', async () => {
      const { data, error: selectError } = await supabaseA
        .from('segment_activities')
        .select('segment_id')
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
      expect(selectError).toBeNull();
      expect(data).toEqual([]);

      const { error: deleteError } = await supabaseA
        .from('segment_activities')
        .delete()
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId)
        .select();
      expect(deleteError).toBeNull();

      const { data: stillThere } = await adminSupabase
        .from('segment_activities')
        .select('segment_id')
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
      expect(stillThere).toHaveLength(1);
    });

    it('他ユーザーの所有物への直接insertもgrant層で拒否する', async () => {
      const { error } = await supabaseA.from('segment_activities').insert({
        segment_id: segmentCase.rowId, // user B の segment
        activity_id: crypto.randomUUID(), // どのユーザーの activity にも存在しない
        user_id: TEST_USER_A_ID,
      });
      expect(error?.code).toBe('42501');
    });

    it('authenticatedのupdateはUPDATE grantが無いため常に42501', async () => {
      const { error } = await supabaseB
        .from('segment_activities')
        .update({ user_id: TEST_USER_B_ID })
        .eq('segment_id', segmentCase.rowId)
        .eq('activity_id', activityCase.rowId);
      expect(error?.code).toBe('42501');
    });
  });

  // #2271。singleton の global lock 状態。user_id を持たず authenticated 全員に SELECT true
  // （個人データではなく MCP write の全体停止スイッチ）。write grant は無いため常に拒否される。
  describe('write_fence_control global read, no write', () => {
    it('authenticatedはグローバル状態をselectできる', async () => {
      const { data, error } = await supabaseA
        .from('write_fence_control')
        .select('singleton_key, fence_enabled');

      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
    });

    it.each(['insert', 'update', 'delete'] as const)(
      'authenticatedの%sはwrite grantが無いため常に42501',
      async (operation) => {
        let query = supabaseA.from('write_fence_control').select();
        if (operation === 'insert') {
          query = supabaseA
            .from('write_fence_control')
            .insert({ singleton_key: true, fence_enabled: true });
        } else if (operation === 'update') {
          query = supabaseA
            .from('write_fence_control')
            .update({ fence_enabled: true })
            .eq('singleton_key', true);
        } else if (operation === 'delete') {
          query = supabaseA.from('write_fence_control').delete().eq('singleton_key', true);
        }

        const { error } = await query;
        expect(error?.code).toBe('42501');
      },
    );
  });

  // #2271。anon/authenticated への GRANT が存在しないため RLS policy の有無に関わらず
  // GRANT 層で 42501 になるテーブル群（PostgREST 到達性そのものの回帰テスト。RLS/GRANT の
  // どちらが原因でも browser client からは同じ 42501 に見えるが、これらは静的な
  // rls-snapshot.md の記述だけでなく e2e でも遮断を実証する）。
  describe('service-role-only tables reject anon/authenticated at the grant layer', () => {
    it.each([
      'mcp_environment_identity',
      'mcp_mutation_control',
      'mcp_mutation_receipts',
      'product_events',
    ] as const)('%s はauthenticatedのselectを42501で拒否する', async (table) => {
      const { error } = await supabaseA.from(table).select('*').limit(1);
      expect(error?.code).toBe('42501');
    });
  });

  describe.each(serviceRoleCases)('$table', (testCase) => {
    it.each(['select', 'insert', 'update', 'delete'] as const)(
      'authenticated clientの%sを拒否する',
      async (operation) => {
        if (operation === 'insert') {
          const { error } = await supabaseA
            .from(testCase.table)
            .insert(testCase.unauthorizedInsert());
          expect(error?.code).toBe('42501');
          return;
        }

        let query = supabaseA.from(testCase.table).select().eq(testCase.idColumn, testCase.rowId);
        if (operation === 'update') {
          query = supabaseA
            .from(testCase.table)
            .update(testCase.update)
            .eq(testCase.idColumn, testCase.rowId)
            .select();
        } else if (operation === 'delete') {
          query = supabaseA
            .from(testCase.table)
            .delete()
            .eq(testCase.idColumn, testCase.rowId)
            .select();
        }

        // #1715: serviceRoleCases の全テーブルが anon/authenticated への table grant を
        // 持たない（oauth_authorization_codes は 20260729062428、stripe_webhook_events /
        // email_suppressions は 20260810085344 で REVOKE ALL 済み）。RLS policy まで
        // 到達せず GRANT 層で 42501 になるので、"empty result, no error" の分岐は無い。
        const { error } = await query;
        expect(error?.code).toBe('42501');
      },
    );
  });

  describe('SECURITY DEFINER RPC user_id guard', () => {
    it.each([
      {
        name: 'update_personalization',
        call: () =>
          supabaseA.rpc('update_personalization', {
            p_path: 'rlsGuard',
            p_user_id: TEST_USER_B_ID,
            p_value: { blocked: true },
          }),
      },
    ])('$name は他ユーザーの p_user_id を拒否する', async ({ call }) => {
      const { error } = await call();

      expect(error?.message).toContain(ACCESS_DENIED_MESSAGE);
    });

    it('拒否された update_personalization は他ユーザー設定を変更しない', async () => {
      const { data, error } = await adminSupabase
        .from('user_settings')
        .select('personalization')
        .eq('user_id', TEST_USER_B_ID)
        .single();

      expect(error).toBeNull();
      expect(JSON.stringify(data?.personalization ?? {})).not.toContain('rlsGuard');
    });

    it('service_role は検証済みサーバー経路として personalization RPC を実行できる', async () => {
      const { error: personalizationError } = await adminSupabase.rpc('update_personalization', {
        p_path: 'rlsServiceRole',
        p_user_id: TEST_USER_B_ID,
        p_value: { allowed: true },
      });
      expect(personalizationError).toBeNull();

      const { data: settings, error: settingsError } = await adminSupabase
        .from('user_settings')
        .select('personalization')
        .eq('user_id', TEST_USER_B_ID)
        .single();

      expect(settingsError).toBeNull();
      expect(JSON.stringify(settings?.personalization ?? {})).toContain('rlsServiceRole');
    });
  });

  describe('Issue #1564 RPC permission matrix', () => {
    beforeAll(async () => {
      const confirmAnchor = Date.now();
      rpcConfirmPlanStartAt = new Date(confirmAnchor - 1_000).toISOString();
      rpcConfirmPlanEndAt = new Date(confirmAnchor + 1_500).toISOString();
      rpcConfirmRangeStartAt = new Date(confirmAnchor - 3_000).toISOString();
      rpcConfirmRangeEndAt = new Date(confirmAnchor + 3_000).toISOString();
      rpcConfirmedAt = new Date(confirmAnchor + 2_000).toISOString();

      const { error: planError } = await adminSupabase.from('plans').insert([
        {
          id: RPC_SOFT_DELETE_PLAN_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC soft-delete plan',
          source: 'manual',
          start_at: RPC_SOFT_DELETE_PLAN_START_AT,
          end_at: RPC_SOFT_DELETE_PLAN_END_AT,
        },
        {
          id: RPC_CONFIRM_PLAN_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC confirm plan',
          source: 'manual',
          start_at: rpcConfirmPlanStartAt,
          end_at: rpcConfirmPlanEndAt,
        },
        {
          id: RPC_RESTORE_PLAN_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC restore plan',
          source: 'manual',
          start_at: RPC_RESTORE_PLAN_START_AT,
          end_at: RPC_RESTORE_PLAN_END_AT,
          deleted_at: rpcConfirmedAt,
        },
      ]);
      if (planError) throw planError;

      const waitForConfirmablePlanMs = new Date(rpcConfirmPlanEndAt).getTime() - Date.now() + 50;
      if (waitForConfirmablePlanMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitForConfirmablePlanMs));
      }

      const { error: recordError } = await adminSupabase.from('records').insert([
        {
          id: RPC_SOFT_DELETE_RECORD_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC soft-delete record',
          source: 'manual',
          start_at: '2026-01-13T00:00:00.000Z',
          end_at: '2026-01-13T01:00:00.000Z',
        },
        {
          id: RPC_RESTORE_RECORD_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC restore record',
          source: 'manual',
          start_at: '2026-01-14T00:00:00.000Z',
          end_at: '2026-01-14T01:00:00.000Z',
          deleted_at: '2026-01-14T02:00:00.000Z',
        },
        {
          id: RPC_AUTO_ACTIVE_RECORD_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC protected active record',
          source: 'auto_migrated',
          start_at: '2026-01-15T00:00:00.000Z',
          end_at: '2026-01-15T01:00:00.000Z',
        },
        {
          id: RPC_AUTO_DELETED_RECORD_ID,
          user_id: TEST_USER_B_ID,
          title: 'RPC protected deleted record',
          source: 'auto_migrated',
          start_at: '2026-01-16T00:00:00.000Z',
          end_at: '2026-01-16T01:00:00.000Z',
          deleted_at: '2026-01-16T02:00:00.000Z',
        },
      ]);
      if (recordError) throw recordError;

      const { error: recoveryError } = await adminSupabase.from('mfa_recovery_codes').insert([
        {
          id: RPC_COUNT_CODE_ID,
          user_id: TEST_USER_B_ID,
          code_hash: RPC_COUNT_CODE_HASH,
        },
        {
          id: RPC_USE_CODE_ID,
          user_id: TEST_USER_B_ID,
          code_hash: RPC_USE_CODE_HASH,
        },
      ]);
      if (recoveryError) throw recoveryError;
    });

    afterAll(async () => {
      await adminSupabase
        .from('records')
        .delete()
        .eq('user_id', TEST_USER_B_ID)
        .eq('start_at', rpcConfirmPlanStartAt);
      await adminSupabase
        .from('records')
        .delete()
        .in('id', [
          RPC_SOFT_DELETE_RECORD_ID,
          RPC_RESTORE_RECORD_ID,
          RPC_AUTO_ACTIVE_RECORD_ID,
          RPC_AUTO_DELETED_RECORD_ID,
        ]);
      await adminSupabase
        .from('plans')
        .delete()
        .in('id', [RPC_SOFT_DELETE_PLAN_ID, RPC_CONFIRM_PLAN_ID, RPC_RESTORE_PLAN_ID]);
      await adminSupabase
        .from('mfa_recovery_codes')
        .delete()
        .in('id', [RPC_COUNT_CODE_ID, RPC_USE_CODE_ID]);
    });

    // #2175 で旧分類モデル専有の 3 RPC を drop したため、継続 invoker RPC は 2 本になった。
    it('2つの継続invoker RPCはcross-userのp_user_idを拒否し対象を変更しない', async () => {
      const calls = [
        () => supabaseA.rpc('count_unused_recovery_codes', { p_user_id: TEST_USER_B_ID }),
        () =>
          supabaseA.rpc('update_personalization', {
            p_path: 'rpcCrossUser',
            p_user_id: TEST_USER_B_ID,
            p_value: { blocked: true },
          }),
      ];

      for (const call of calls) {
        const { error } = await call();
        expect(error?.message).toContain(ACCESS_DENIED_MESSAGE);
      }

      const { data: settings } = await adminSupabase
        .from('user_settings')
        .select('personalization')
        .eq('user_id', TEST_USER_B_ID)
        .single();

      expect(JSON.stringify(settings?.personalization ?? {})).not.toContain('rpcCrossUser');
    });

    it('2つの継続invoker RPCはowner経路で成功する', async () => {
      const { data: count, error: countError } = await supabaseB.rpc(
        'count_unused_recovery_codes',
        { p_user_id: TEST_USER_B_ID },
      );
      expect(countError).toBeNull();
      expect(count).toBeGreaterThanOrEqual(2);

      const { error: personalizationError } = await supabaseB.rpc('update_personalization', {
        p_path: 'rpcOwner',
        p_user_id: TEST_USER_B_ID,
        p_value: { allowed: true },
      });
      expect(personalizationError).toBeNull();
    });

    // Candidate 6 は plans / records の直接 DML だけを剥がし、旧 bundle が呼ぶ 3 RPC の
    // authenticated EXECUTE は残す。EXECUTE を落とすのは旧 instance の drain 後。
    // 実行できた上で owner 照合が働くことを、message で区別して固定する。
    it('旧bundle向け3 RPCはcross-user実行をowner照合で拒否し対象を変更しない', async () => {
      const calls = [
        () =>
          supabaseA.rpc('confirm_day_plans_to_records', {
            p_confirmed_at: rpcConfirmedAt,
            p_end_at: rpcConfirmRangeEndAt,
            p_start_at: rpcConfirmRangeStartAt,
            p_user_id: TEST_USER_B_ID,
          }),
        () =>
          supabaseA.rpc('soft_delete_plan', {
            p_plan_id: RPC_SOFT_DELETE_PLAN_ID,
            p_user_id: TEST_USER_B_ID,
          }),
        () =>
          supabaseA.rpc('soft_delete_record', {
            p_record_id: RPC_SOFT_DELETE_RECORD_ID,
            p_user_id: TEST_USER_B_ID,
          }),
      ];

      for (const call of calls) {
        const { error } = await call();
        // EXECUTE 権限不足 (42501 permission denied for function) ではなく、
        // 関数内の auth.uid() 照合で落ちていることを message で証明する
        expect(error?.message).toContain(ACCESS_DENIED_MESSAGE);
      }

      const [{ data: plan }, { data: record }, { data: confirmed }] = await Promise.all([
        adminSupabase.from('plans').select('deleted_at').eq('id', RPC_SOFT_DELETE_PLAN_ID).single(),
        adminSupabase
          .from('records')
          .select('deleted_at')
          .eq('id', RPC_SOFT_DELETE_RECORD_ID)
          .single(),
        adminSupabase
          .from('records')
          .select('id')
          .eq('user_id', TEST_USER_B_ID)
          .eq('start_at', rpcConfirmPlanStartAt),
      ]);
      expect(plan?.deleted_at).toBeNull();
      expect(record?.deleted_at).toBeNull();
      expect(confirmed).toEqual([]);
    });

    it('旧bundle向け3 RPCはauthenticated owner互換をdrainまで維持する', async () => {
      const { data: confirmed, error: confirmError } = await supabaseB.rpc(
        'confirm_day_plans_to_records',
        {
          p_confirmed_at: rpcConfirmedAt,
          p_end_at: rpcConfirmRangeEndAt,
          p_start_at: rpcConfirmRangeStartAt,
          p_user_id: TEST_USER_B_ID,
        },
      );
      expect(confirmError).toBeNull();
      expect(confirmed).toHaveLength(1);
      expect(confirmed?.[0]).not.toHaveProperty('fulfillment_score');

      const { error: planError } = await supabaseB.rpc('soft_delete_plan', {
        p_plan_id: RPC_SOFT_DELETE_PLAN_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(planError).toBeNull();

      const { error: recordError } = await supabaseB.rpc('soft_delete_record', {
        p_record_id: RPC_SOFT_DELETE_RECORD_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(recordError).toBeNull();

      // SELECT は残っているので、RPC の効果を browser client から確認できる
      const [{ data: deletedPlans }, { data: deletedRecords }] = await Promise.all([
        supabaseB.from('plans').select('id').eq('id', RPC_SOFT_DELETE_PLAN_ID),
        supabaseB.from('records').select('id').eq('id', RPC_SOFT_DELETE_RECORD_ID),
      ]);
      expect(deletedPlans).toEqual([]);
      expect(deletedRecords).toEqual([]);
    });

    it('3つのprivileged RPCはauthenticated直接実行を42501で拒否する', async () => {
      const calls = [
        () =>
          supabaseB.rpc('restore_plan', {
            p_plan_id: RPC_RESTORE_PLAN_ID,
            p_user_id: TEST_USER_B_ID,
          }),
        () =>
          supabaseB.rpc('restore_record', {
            p_record_id: RPC_RESTORE_RECORD_ID,
            p_user_id: TEST_USER_B_ID,
          }),
        () =>
          supabaseB.rpc('use_recovery_code', {
            p_code_hash: RPC_USE_CODE_HASH,
            p_user_id: TEST_USER_B_ID,
          }),
      ];

      for (const call of calls) {
        const { error } = await call();
        expect(error?.code).toBe('42501');
      }
    });

    it('3つのprivileged RPCはservice-role経路で成功する', async () => {
      const { error: planError } = await adminSupabase.rpc('restore_plan', {
        p_plan_id: RPC_RESTORE_PLAN_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(planError).toBeNull();

      const { error: recordError } = await adminSupabase.rpc('restore_record', {
        p_record_id: RPC_RESTORE_RECORD_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(recordError).toBeNull();

      const { data: used, error: recoveryError } = await adminSupabase.rpc('use_recovery_code', {
        p_code_hash: RPC_USE_CODE_HASH,
        p_user_id: TEST_USER_B_ID,
      });
      expect(recoveryError).toBeNull();
      expect(used).toBe(true);
    });

    it('auto_migrated Recordはcaller roleに関係なくdelete/restoreできない', async () => {
      const { error: userDeleteError } = await supabaseB.rpc('soft_delete_record', {
        p_record_id: RPC_AUTO_ACTIVE_RECORD_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(userDeleteError).not.toBeNull();

      const { error: serviceDeleteError } = await adminSupabase.rpc('soft_delete_record', {
        p_record_id: RPC_AUTO_ACTIVE_RECORD_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(serviceDeleteError).not.toBeNull();

      const { error: serviceRestoreError } = await adminSupabase.rpc('restore_record', {
        p_record_id: RPC_AUTO_DELETED_RECORD_ID,
        p_user_id: TEST_USER_B_ID,
      });
      expect(serviceRestoreError).not.toBeNull();

      const [{ data: active }, { data: deleted }] = await Promise.all([
        adminSupabase
          .from('records')
          .select('deleted_at')
          .eq('id', RPC_AUTO_ACTIVE_RECORD_ID)
          .single(),
        adminSupabase
          .from('records')
          .select('deleted_at')
          .eq('id', RPC_AUTO_DELETED_RECORD_ID)
          .single(),
      ]);
      expect(active?.deleted_at).toBeNull();
      expect(deleted?.deleted_at).not.toBeNull();
    });
  });

  it('I-16 snapshotがsuiteの全対象テーブルを含む', () => {
    const snapshot = readFileSync(
      resolve(process.cwd(), '../../docs/engineering/data/db/rls-snapshot.md'),
      'utf8',
    );

    for (const { table } of [...userOwnedCases, ...serviceRoleCases]) {
      expect(snapshot).toContain(`### ${table}`);
    }
    expect(
      snapshot.match(
        /\| No browser client access \| ALL \| PERMISSIVE \| \{anon,authenticated\} \| false \| false\s+\|/g,
      ),
    ).toHaveLength(serviceRoleCases.length);
    expect(snapshot).not.toContain('### user_badges');
    expect(snapshot).not.toContain('### api_keys');
  });

  it('I-16 snapshotがPlan / Recordのwrite境界を記録する', () => {
    const snapshot = readFileSync(
      resolve(process.cwd(), '../../docs/engineering/data/db/rls-snapshot.md'),
      'utf8',
    );

    expect(snapshot).toContain('## Plan / Record effective write境界');
    expect(snapshot).toContain(
      '✅ `anon` / `authenticated`のeffective table / column write権限なし',
    );

    // table 権限は SELECT だけ。TRUNCATE / MAINTAIN を含む privilege も snapshot に
    // 出るようフィルタを外してあるので、混入すればこの行が変わる
    for (const table of ['plans', 'records']) {
      expect(snapshot).toMatch(
        new RegExp(`\\| table\\s+\\| public\\.${table}\\s+\\| authenticated\\s+\\| SELECT\\s+\\|`),
      );
    }
    expect(snapshot).not.toMatch(/\| (table|column)\s+\| public\.plans\S*\s+\| anon\s+\|/);
    expect(snapshot).not.toMatch(/\| (table|column)\s+\| public\.records\S*\s+\| anon\s+\|/);
  });

  it('I-16 snapshotがcalendar_connectionsのcolumn grantを列単位で記録する', () => {
    const snapshot = readFileSync(
      resolve(process.cwd(), '../../docs/engineering/data/db/rls-snapshot.md'),
      'utf8',
    );

    expect(snapshot).toContain('### calendar_connections');
    expect(snapshot).toContain('### calendar_connection_calendars');

    for (const column of CALENDAR_CONNECTION_GRANTED_COLUMNS) {
      expect(snapshot).toContain(`public.calendar_connections.${column}`);
    }
    for (const column of CALENDAR_CONNECTION_WITHHELD_COLUMNS) {
      expect(snapshot).not.toContain(`public.calendar_connections.${column}`);
    }

    // table 単位の SELECT を authenticated に与えていないことの記録。
    // 与えてしまうと列単位の grant が意味を失う
    expect(snapshot).not.toMatch(
      /\| table\s+\| public\.calendar_connections\s+\| authenticated\s+\|/,
    );
  });
});
