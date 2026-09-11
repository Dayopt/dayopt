import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

/**
 * `20260730090017_fenced_calendar_sync_writers.sql` の fenced sync writer RPC 群の
 * integration test（#2050）。overview.md §7 が必須と定める受け入れ条件（disconnect
 * 後の書き込み拒否）と、#2078 の allowlist 拡張を固定する。CAS ロジック本体の網羅は対象外
 * — ここでは begin → disconnect → persist/finish の race だけを再現する。
 *
 * #2289: 5 RPC すべて `REVOKE ALL ... GRANT EXECUTE ... TO service_role` のみで、
 * anon/authenticated には EXECUTE 権限自体が無い。この実 shape（PostgREST が返す
 * `error.code === '42501'`）を pin し、`fenced-sync-writer.ts` の definitive 分類
 * （`DEFINITIVE_CODES_WITH_ALERT`）が実際の DB 応答と一致していることを固定する。
 */

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * anon DB role を確実に踏む client。新しい local Supabase project は asymmetric JWT key
 * を公開するため、legacy anon key を Bearer JWT として同時提示すると role 解決が変わる
 * （`external-authority-maintenance.integration.test.ts` と同じ回避策）。
 */
const anonymous = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('Authorization');
      return fetch(input, { ...init, headers });
    },
  },
});

function createRunProjectNumber(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (value, index) =>
    String(index === 0 ? (value % 9) + 1 : value % 10),
  ).join('');
}

const projectKey = createRunProjectNumber();
const oauthClientId = `${projectKey}-dayoptcalendar.apps.googleusercontent.com`;
const userId = crypto.randomUUID();
const userEmail = `calendar-sync-writer-${userId}@example.com`;
const connectionId = crypto.randomUUID();
const calendarSelectionId = crypto.randomUUID();

function ownerSql(sql: string, variables: Record<string, string> = {}): string {
  const result = spawnSync(
    'psql',
    [
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
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: 'postgres' },
      input: sql,
    },
  );

  if (result.status !== 0) {
    throw new Error(`Calendar sync writer SQL failed: ${result.stderr}`);
  }
  return result.stdout.trim().split('\n').at(-1) ?? '';
}

function serviceRoleSql(sql: string, variables: Record<string, string> = {}): string {
  return ownerSql(
    `SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  FALSE
);
${sql}`,
    variables,
  );
}

function cleanupFixture(): void {
  ownerSql(
    `DELETE FROM public.external_calendar_events
WHERE user_id = :'user_id'::UUID;
DELETE FROM public.calendar_connection_calendars
WHERE user_id = :'user_id'::UUID;
DELETE FROM public.calendar_connections
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.calendar_authority_fences
WHERE project_key = :'project_key';
DELETE FROM private.calendar_authority_projects
WHERE project_key = :'project_key';
DELETE FROM auth.users
WHERE id = :'user_id'::UUID;`,
    {
      project_key: projectKey,
      user_id: userId,
    },
  );
}

/**
 * 接続を作る（fence 込み）。`calendar-revoke-authority.integration.test.ts` と同じ
 * provisioning パターンを流用する。返り値は `begin_calendar_sync_run_v1` の CAS 入力。
 */
function setupConnection(): { authorityFenceId: string; authorityEpoch: number } {
  serviceRoleSql(
    `SELECT public.provision_calendar_authority_project_v1(
  :'project_key',
  :'oauth_client_id'
);`,
    { oauth_client_id: oauthClientId, project_key: projectKey },
  );

  serviceRoleSql(
    `UPDATE private.calendar_authority_projects AS project
SET activation_version = 1,
    activated_at = pg_catalog.clock_timestamp()
WHERE project.project_key = :'project_key';

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  :'user_id'::UUID, 'authenticated', 'authenticated', :'user_email', '',
  '{}'::JSONB, '{}'::JSONB, pg_catalog.now(), pg_catalog.now()
);

SELECT private.get_or_create_calendar_subject_fence_v1(
  :'project_key',
  'calendar-sync-writer-subject'
);

INSERT INTO public.calendar_connections (
  id, user_id, provider, provider_account_id, granted_scopes,
  refresh_token_enc, status, data_generation, authority_fence_id, authority_epoch
)
SELECT
  :'connection_id'::UUID, :'user_id'::UUID, 'google', 'calendar-sync-writer-subject',
  ARRAY['calendar.readonly']::TEXT[], 'v1.integration-ciphertext', 'active', 0,
  fence.id, fence.epoch
FROM private.calendar_authority_fences AS fence
WHERE fence.project_key = :'project_key'
  AND fence.scope_kind = 'subject'
  AND fence.provider_account_id = 'calendar-sync-writer-subject';

INSERT INTO public.calendar_connection_calendars (
  id, user_id, connection_id, provider_calendar_id, calendar_name
) VALUES (
  :'calendar_selection_id'::UUID, :'user_id'::UUID, :'connection_id'::UUID, 'primary', 'Primary'
);`,
    {
      calendar_selection_id: calendarSelectionId,
      connection_id: connectionId,
      project_key: projectKey,
      user_id: userId,
      user_email: userEmail,
    },
  );

  const [authorityFenceId, authorityEpoch] = ownerSql(
    `SELECT authority_fence_id || '|' || authority_epoch
FROM public.calendar_connections
WHERE id = :'connection_id'::UUID;`,
    { connection_id: connectionId },
  ).split('|');

  return { authorityFenceId: authorityFenceId!, authorityEpoch: Number(authorityEpoch) };
}

describe.skipIf(!RUN_LOCAL)('Calendar fenced sync writer contract (#2050)', () => {
  afterEach(() => {
    cleanupFixture();
  });

  it('begin 後に disconnect（connection 行 delete）が入ると、以後の書き込みは missing で拒否され、ミラー行は 1 行も生えない', async () => {
    const { authorityFenceId, authorityEpoch } = setupConnection();

    const { data: beginRows, error: beginError } = await admin.rpc('begin_calendar_sync_run_v1', {
      p_project_key: projectKey,
      p_user_id: userId,
      p_connection_id: connectionId,
    });
    expect(beginError).toBeNull();
    const begin = beginRows![0]!;
    expect(begin.result).toBe('started');

    // disconnect() は connection 行を hard delete する（connection-service.ts:687-743）。
    ownerSql(`DELETE FROM public.calendar_connections WHERE id = :'connection_id'::UUID;`, {
      connection_id: connectionId,
    });

    const runStartedAt = begin.run_started_at;
    const { data: persistResult, error: persistError } = await admin.rpc(
      'persist_calendar_sync_result_command_v1',
      {
        p_project_key: projectKey,
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_generation: begin.data_generation,
        p_expected_authority_fence_id: authorityFenceId,
        p_expected_authority_epoch: authorityEpoch,
        p_expected_sync_sequence: begin.sync_sequence,
        p_calendar_selection_id: calendarSelectionId,
        p_provider_calendar_id: 'primary',
        p_run_started_at: runStartedAt,
        p_events: [
          {
            providerEventId: 'ev-1',
            title: 'Standup',
            description: null,
            startAt: '2026-08-20T09:00:00.000Z',
            endAt: '2026-08-20T09:30:00.000Z',
          },
        ],
        p_tombstone_event_ids: [],
        p_used_full_sync: false,
        p_next_cursor: 'next-token',
      },
    );
    expect(persistError).toBeNull();
    expect(persistResult).toBe('missing');

    const { data: finishResult, error: finishError } = await admin.rpc(
      'finish_calendar_sync_run_v1',
      {
        p_project_key: projectKey,
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_generation: begin.data_generation,
        p_expected_authority_fence_id: authorityFenceId,
        p_expected_authority_epoch: authorityEpoch,
        p_expected_sync_sequence: begin.sync_sequence,
        p_run_started_at: runStartedAt,
        p_last_sync_error: null,
        p_prune_window: false,
        p_not_before: null,
        p_not_after: null,
      },
    );
    expect(finishError).toBeNull();
    expect(finishResult).toBe('missing');

    const mirrorCount = ownerSql(
      `SELECT pg_catalog.count(*)::TEXT FROM public.external_calendar_events
WHERE user_id = :'user_id'::UUID;`,
      { user_id: userId },
    );
    expect(mirrorCount).toBe('0');
  });

  // #2078: allowlist 拡張前は 22023 で拒否されていた値。
  it('finish_calendar_sync_run_v1 は partial_timeout を last_sync_error として受理する', async () => {
    const { authorityFenceId, authorityEpoch } = setupConnection();

    const { data: beginRows, error: beginError } = await admin.rpc('begin_calendar_sync_run_v1', {
      p_project_key: projectKey,
      p_user_id: userId,
      p_connection_id: connectionId,
    });
    expect(beginError).toBeNull();
    const begin = beginRows![0]!;

    const { data: finishResult, error: finishError } = await admin.rpc(
      'finish_calendar_sync_run_v1',
      {
        p_project_key: projectKey,
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_generation: begin.data_generation,
        p_expected_authority_fence_id: authorityFenceId,
        p_expected_authority_epoch: authorityEpoch,
        p_expected_sync_sequence: begin.sync_sequence,
        p_run_started_at: begin.run_started_at,
        p_last_sync_error: 'partial_timeout',
        p_prune_window: false,
        p_not_before: null,
        p_not_after: null,
      },
    );
    expect(finishError).toBeNull();
    expect(finishResult).toBe('finished');

    const lastSyncError = ownerSql(
      `SELECT last_sync_error FROM public.calendar_connections WHERE id = :'connection_id'::UUID;`,
      { connection_id: connectionId },
    );
    expect(lastSyncError).toBe('partial_timeout');
  });

  // #2289: begin_calendar_sync_run_v1 は service_role にしか EXECUTE 権限が無い
  // （`REVOKE ALL ... GRANT EXECUTE ... TO service_role`）。この privilege check は関数
  // 本体（assert_timeblock_service_role_request_v1）に入る前に PostgREST 層で決着するため、
  // 接続 fixture の準備は不要 — 存在しない connection_id でも同じ 42501 になる。
  it('anon role で呼ぶと EXECUTE 権限が無く 42501（permission denied）で拒否される', async () => {
    const { error } = await anonymous.rpc('begin_calendar_sync_run_v1', {
      p_project_key: projectKey,
      p_user_id: userId,
      p_connection_id: connectionId,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });
});
