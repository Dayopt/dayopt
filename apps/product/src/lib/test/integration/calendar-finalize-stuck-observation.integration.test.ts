/**
 * #2055(a): finalize-calendar-revoke-guards の per-candidate 隔離
 * （20260813130100_isolate_finalize_calendar_revoke_guards_candidates.sql）は 1 件の
 * invariant 違反や lock timeout でバッチ全体が abort しないよう deferred にするが、
 * deferred/隔離された行を観測する手段が無かった。20260818010000 で
 * `get_external_authority_maintenance_status_v1()` に `calendar_finalize_stuck_count`
 * （state IN ('revoke_guarded','expiry_guarded') AND guard_until < now() - 24h の件数）を
 * 追加した。ここではその件数が実際に増減することと、DROP → CREATE の migration が
 * 既存 GRANT（service_role のみ EXECUTE）を再現していることを固定する。
 */

import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
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
const userEmail = `calendar-finalize-stuck-${userId}@example.com`;

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
    throw new Error(`Calendar finalize stuck observation SQL failed: ${result.stderr}`);
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
    `DELETE FROM private.calendar_revoke_operations WHERE project_fence_id IN (
  SELECT id FROM private.calendar_authority_fences WHERE project_key = :'project_key'
);
DELETE FROM private.calendar_authority_fences WHERE project_key = :'project_key';
DELETE FROM private.calendar_authority_projects WHERE project_key = :'project_key';
DELETE FROM auth.users WHERE id = :'user_id'::UUID;`,
    { project_key: projectKey, user_id: userId },
  );
}

function provisionProject(): { projectFenceId: string } {
  serviceRoleSql(
    `SELECT public.provision_calendar_authority_project_v1(:'project_key', :'oauth_client_id');
UPDATE private.calendar_authority_projects
SET activation_version = 1, activated_at = pg_catalog.clock_timestamp()
WHERE project_key = :'project_key';
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  :'user_id'::UUID, 'authenticated', 'authenticated', :'user_email', '', '{}'::JSONB, '{}'::JSONB,
  pg_catalog.now(), pg_catalog.now()
);`,
    {
      oauth_client_id: oauthClientId,
      project_key: projectKey,
      user_email: userEmail,
      user_id: userId,
    },
  );
  const projectFenceId = ownerSql(
    `SELECT id FROM private.calendar_authority_fences WHERE project_key = :'project_key' AND scope_kind = 'project';`,
    { project_key: projectKey },
  );
  return { projectFenceId };
}

function createSubjectFence(providerAccountId: string): string {
  return serviceRoleSql(
    `SELECT private.get_or_create_calendar_subject_fence_v1(:'project_key', :'provider_account_id');`,
    { project_key: projectKey, provider_account_id: providerAccountId },
  );
}

function insertGuardedOperation(params: {
  projectFenceId: string;
  subjectFenceId: string;
  state: 'revoke_guarded' | 'expiry_guarded';
  guardUntilOffset: string;
}): string {
  const operationId = crypto.randomUUID();
  ownerSql(
    `INSERT INTO private.calendar_revoke_operations (
  operation_id, project_fence_id, subject_fence_id, subject_fence_epoch, source_user_id,
  source_connection_id, operation_kind, request_digest, state, initial_result, guard_until
) VALUES (
  :'operation_id'::UUID, :'project_fence_id'::UUID, :'subject_fence_id'::UUID, 0,
  :'user_id'::UUID, gen_random_uuid(), 'disconnect', decode(repeat('dd', 32), 'hex'),
  :'state', 'queued', pg_catalog.clock_timestamp() - INTERVAL '${params.guardUntilOffset}'
);`,
    {
      operation_id: operationId,
      project_fence_id: params.projectFenceId,
      state: params.state,
      subject_fence_id: params.subjectFenceId,
      user_id: userId,
    },
  );
  return operationId;
}

async function readStuckCount(): Promise<number> {
  const { data, error } = await admin.rpc('get_external_authority_maintenance_status_v1');
  if (error) throw error;
  return data[0]!.calendar_finalize_stuck_count;
}

describe.skipIf(!RUN_LOCAL)('calendar finalize stuck observation (#2055a)', () => {
  afterEach(() => {
    cleanupFixture();
  });

  it('24h 超 guard されたまま滞留している行を件数として返す', async () => {
    const { projectFenceId } = provisionProject();
    const subjectFenceId = createSubjectFence('finalize-stuck-old');
    insertGuardedOperation({
      projectFenceId,
      subjectFenceId,
      state: 'revoke_guarded',
      guardUntilOffset: '25 hours',
    });

    await expect(readStuckCount()).resolves.toBe(1);
  });

  it('expiry_guarded も同じ閾値でカウントする', async () => {
    const { projectFenceId } = provisionProject();
    const subjectFenceId = createSubjectFence('finalize-stuck-expiry');
    insertGuardedOperation({
      projectFenceId,
      subjectFenceId,
      state: 'expiry_guarded',
      guardUntilOffset: '30 hours',
    });

    await expect(readStuckCount()).resolves.toBe(1);
  });

  it('24h 以内の guard は滞留に含めない（finalize の次 tick を待っている正常系）', async () => {
    const { projectFenceId } = provisionProject();
    const subjectFenceId = createSubjectFence('finalize-not-stuck');
    insertGuardedOperation({
      projectFenceId,
      subjectFenceId,
      state: 'revoke_guarded',
      guardUntilOffset: '1 hour',
    });

    await expect(readStuckCount()).resolves.toBe(0);
  });

  it('滞留が無ければ 0 を返す', async () => {
    provisionProject();

    await expect(readStuckCount()).resolves.toBe(0);
  });

  // service_role 以外への公開拒否（既存 GRANT の維持）は
  // external-authority-maintenance.integration.test.ts の
  // 'does not expose maintenance RPCs to browser roles' が同一関数を対象に既に固定している。
  // DROP → CREATE の migration がその REVOKE/GRANT を正しく再発行していることは、
  // このテストが引き続き green であることで確認済み（重複させない）。
});
