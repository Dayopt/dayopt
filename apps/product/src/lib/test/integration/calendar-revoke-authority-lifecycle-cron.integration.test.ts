/**
 * private.expire_calendar_revoke_ciphertexts_internal_v1 と
 * private.finalize_calendar_revoke_guards_internal_v1 の cron 配線を固定する。
 *
 * #2002: どちらの関数も 20260730090015/090016 で追加されたが、呼び出す cron が
 * 存在しなかった。finalize だけを配線しても Goal は成立しない —
 * finalize は state IN ('revoke_guarded','expiry_guarded') の行しか進めず、
 * pending のまま expires_at を過ぎた行は expire 側でしか動かせない
 * （state CHECK 制約により pending 中は delete_after が常に NULL、
 * 20260730090012）。20260813130000_schedule_calendar_revoke_authority_lifecycle.sql
 * で両方を配線した。ここでは配線の契約（schedule/command のリテラル）と、
 * 各関数が実際に意図した state 遷移を起こすことを固定する。
 */

import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

function createRunProjectNumber(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (value, index) =>
    String(index === 0 ? (value % 9) + 1 : value % 10),
  ).join('');
}

const projectKey = createRunProjectNumber();
const oauthClientId = `${projectKey}-dayoptcalendar.apps.googleusercontent.com`;
const userId = crypto.randomUUID();
const userEmail = `calendar-revoke-lifecycle-cron-${userId}@example.com`;

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
    throw new Error(`Calendar revoke lifecycle cron SQL failed: ${result.stderr}`);
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

function runExpire(projectFenceId: string): number {
  return Number(
    ownerSql(
      `SELECT result.ciphertexts_deleted
FROM private.calendar_authority_fences AS fence,
  LATERAL private.expire_calendar_revoke_ciphertexts_internal_v1(fence.id, 1000) AS result
WHERE fence.id = :'project_fence_id'::UUID;`,
      { project_fence_id: projectFenceId },
    ),
  );
}

function runFinalize(limit = 1000): number {
  return Number(ownerSql(`SELECT private.finalize_calendar_revoke_guards_internal_v1(${limit});`));
}

describe.skipIf(!RUN_LOCAL)('calendar revoke authority lifecycle cron', () => {
  afterEach(() => {
    cleanupFixture();
  });

  it('cron に正しい関数名・引数・スケジュールで登録されている（expire / finalize 両方）', () => {
    // #2681: 開始/完了heartbeatで包んだ元の保守SQL（2行目）とscheduleを固定する。
    expect(
      ownerSql(
        `SELECT schedule || '|' || split_part(command, chr(10), 2)
FROM cron.job
WHERE jobname = 'expire-calendar-revoke-authority';`,
      ),
    ).toBe(
      "10 * * * *|SELECT private.expire_calendar_revoke_ciphertexts_internal_v1(fence.id, 1000) FROM private.calendar_authority_fences AS fence WHERE fence.scope_kind = 'project'",
    );

    // #2681: 開始/完了heartbeatで包んだ元の保守SQL（2行目）とscheduleを固定する。
    expect(
      ownerSql(
        `SELECT schedule || '|' || split_part(command, chr(10), 2)
FROM cron.job
WHERE jobname = 'finalize-calendar-revoke-guards';`,
      ),
    ).toBe('15 * * * *|SELECT private.finalize_calendar_revoke_guards_internal_v1(1000)');
  });

  it('進行中の attempt が無い pending 行は expire だけで expired + delete_after 確定まで進む（finalize 不要）', () => {
    const { projectFenceId } = provisionProject();
    const subjectFenceId = createSubjectFence('lifecycle-cron-no-attempt');
    const operationId = crypto.randomUUID();

    ownerSql(
      // settle_calendar_revoke_operation_v1 は subject fence の pending_operation_count > 0
      // を invariant として要求する（違反は CA012 で RAISE）。実際の書き込み経路
      // （save_calendar_connection_command_v2 等）は operation の INSERT と同一トランザクションで
      // この列を +1 するため、fixture でも同じ bookkeeping を揃える。
      `UPDATE private.calendar_authority_fences
SET pending_operation_count = pending_operation_count + 1, state = 'pending'
WHERE id = :'subject_fence_id'::UUID;

INSERT INTO private.calendar_revoke_operations (
  operation_id, project_fence_id, subject_fence_id, subject_fence_epoch, source_user_id,
  source_connection_id, operation_kind, request_digest, state, initial_result, created_at, expires_at
) VALUES (
  :'operation_id'::UUID, :'project_fence_id'::UUID, :'subject_fence_id'::UUID, 0,
  :'user_id'::UUID, gen_random_uuid(), 'disconnect', decode(repeat('88', 32), 'hex'), 'pending',
  'queued', pg_catalog.clock_timestamp() - INTERVAL '10 minutes',
  pg_catalog.clock_timestamp() - INTERVAL '1 second'
);`,
      {
        operation_id: operationId,
        project_fence_id: projectFenceId,
        subject_fence_id: subjectFenceId,
        user_id: userId,
      },
    );

    const expiredCount = runExpire(projectFenceId);
    expect(expiredCount).toBe(1);

    expect(
      ownerSql(
        `SELECT state || '|' || (delete_after IS NOT NULL)
FROM private.calendar_revoke_operations WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: operationId },
      ),
    ).toBe('expired|true');

    // finalize は revoke_guarded/expiry_guarded にしか作用しないため、既に expired の
    // この行には触れず、0 件のまま安全に終わる。
    expect(runFinalize()).toBe(0);
  });

  it('guard_until を過ぎた revoke_guarded 行は finalize で revoked + delete_after 確定まで進む', () => {
    const { projectFenceId } = provisionProject();
    const subjectFenceId = createSubjectFence('lifecycle-cron-guarded');
    const operationId = crypto.randomUUID();

    ownerSql(
      // pending_operation_count の bookkeeping 理由は上のテストと同じ
      // （settle_calendar_revoke_operation_v1 の invariant、CA012）。
      `UPDATE private.calendar_authority_fences
SET pending_operation_count = pending_operation_count + 1, state = 'pending'
WHERE id = :'subject_fence_id'::UUID;

INSERT INTO private.calendar_revoke_operations (
  operation_id, project_fence_id, subject_fence_id, subject_fence_epoch, source_user_id,
  source_connection_id, operation_kind, request_digest, state, initial_result, guard_until
) VALUES (
  :'operation_id'::UUID, :'project_fence_id'::UUID, :'subject_fence_id'::UUID, 0,
  :'user_id'::UUID, gen_random_uuid(), 'disconnect', decode(repeat('99', 32), 'hex'),
  'revoke_guarded', 'queued', pg_catalog.clock_timestamp() - INTERVAL '1 second'
);`,
      {
        operation_id: operationId,
        project_fence_id: projectFenceId,
        subject_fence_id: subjectFenceId,
        user_id: userId,
      },
    );

    // expire は state = 'pending' しか対象にしないため、guarded 行には触れない。
    expect(runExpire(projectFenceId)).toBe(0);

    const finalizedCount = runFinalize();
    expect(finalizedCount).toBe(1);

    expect(
      ownerSql(
        `SELECT state || '|' || (delete_after IS NOT NULL)
FROM private.calendar_revoke_operations WHERE operation_id = :'operation_id'::UUID;`,
        { operation_id: operationId },
      ),
    ).toBe('revoked|true');
  });

  // risk-reviewer 指摘（2026-08-13）: settle_calendar_revoke_operation_v1 の CA012
  // invariant（subject fence の pending_operation_count > 0）違反のような 1 件の失敗が、
  // 同じバッチ内の他の正常な行の finalize まで道連れにしないこと（per-candidate 隔離）を固定する。
  // 20260813130100_isolate_finalize_calendar_revoke_guards_candidates.sql で対応。
  it('1 件が invariant 違反で失敗しても、同じバッチの他の正常な行は finalize される', () => {
    const { projectFenceId } = provisionProject();
    const poisonSubjectFenceId = createSubjectFence('lifecycle-cron-poison');
    const healthySubjectFenceId = createSubjectFence('lifecycle-cron-healthy');
    const poisonOperationId = crypto.randomUUID();
    const healthyOperationId = crypto.randomUUID();

    ownerSql(
      // poison 側だけ pending_operation_count の bookkeeping をわざと省き、
      // settle 時に CA012（invariant 違反）で失敗する状態を作る。healthy 側は正しく揃える。
      `UPDATE private.calendar_authority_fences
SET pending_operation_count = pending_operation_count + 1, state = 'pending'
WHERE id = :'healthy_subject_fence_id'::UUID;

INSERT INTO private.calendar_revoke_operations (
  operation_id, project_fence_id, subject_fence_id, subject_fence_epoch, source_user_id,
  source_connection_id, operation_kind, request_digest, state, initial_result, guard_until
) VALUES
(
  :'poison_operation_id'::UUID, :'project_fence_id'::UUID, :'poison_subject_fence_id'::UUID, 0,
  :'user_id'::UUID, gen_random_uuid(), 'disconnect', decode(repeat('bb', 32), 'hex'),
  'revoke_guarded', 'queued', pg_catalog.clock_timestamp() - INTERVAL '2 seconds'
),
(
  :'healthy_operation_id'::UUID, :'project_fence_id'::UUID, :'healthy_subject_fence_id'::UUID, 0,
  :'user_id'::UUID, gen_random_uuid(), 'disconnect', decode(repeat('cc', 32), 'hex'),
  'revoke_guarded', 'queued', pg_catalog.clock_timestamp() - INTERVAL '1 second'
);`,
      {
        healthy_operation_id: healthyOperationId,
        healthy_subject_fence_id: healthySubjectFenceId,
        poison_operation_id: poisonOperationId,
        poison_subject_fence_id: poisonSubjectFenceId,
        project_fence_id: projectFenceId,
        user_id: userId,
      },
    );

    const finalizedCount = runFinalize();
    expect(finalizedCount).toBe(1);

    expect(
      ownerSql(
        `SELECT state FROM private.calendar_revoke_operations WHERE operation_id = :'poison_operation_id'::UUID;`,
        { poison_operation_id: poisonOperationId },
      ),
    ).toBe('revoke_guarded');

    expect(
      ownerSql(
        `SELECT state FROM private.calendar_revoke_operations WHERE operation_id = :'healthy_operation_id'::UUID;`,
        { healthy_operation_id: healthyOperationId },
      ),
    ).toBe('revoked');
  });

  it('owner 以外（service_role を含む）は直接呼べない', () => {
    expect(() =>
      ownerSql(
        `SET ROLE service_role;
SELECT private.finalize_calendar_revoke_guards_internal_v1(10);`,
      ),
    ).toThrow(/permission denied/i);

    expect(() =>
      ownerSql(
        `SET ROLE service_role;
SELECT private.expire_calendar_revoke_ciphertexts_internal_v1(gen_random_uuid(), 10);`,
      ),
    ).toThrow(/permission denied/i);
  });
});
