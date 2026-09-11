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
const userEmail = `calendar-revoke-authority-${userId}@example.com`;
const connectionId = crypto.randomUUID();
const operationId = crypto.randomUUID();

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
    throw new Error(`Calendar revoke authority SQL failed: ${result.stderr}`);
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

function assertNoCalendarAuthorityProject(): void {
  const count = ownerSql(
    'SELECT pg_catalog.count(*)::TEXT FROM private.calendar_authority_projects;',
  );
  if (count !== '0') {
    throw new Error('Calendar revoke fixture requires an empty authority project singleton');
  }
}

function cleanupFixture(): void {
  ownerSql(
    `DELETE FROM private.calendar_account_deletion_intents
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.calendar_revoke_outbox
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.calendar_authority_command_receipts
WHERE source_user_id = :'user_id'::UUID;
DELETE FROM private.calendar_revoke_operations
WHERE source_user_id = :'user_id'::UUID;
DELETE FROM private.integration_security_events
WHERE user_id = :'user_id'::UUID;
DELETE FROM private.calendar_oauth_attempts
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

async function claimOne() {
  const { data, error } = await admin.rpc('claim_calendar_revoke_outbox_v2', {
    p_project_key: projectKey,
    p_limit: 1,
  });
  if (error) throw error;
  return data;
}

describe.skipIf(!RUN_LOCAL)('Calendar revoke authority worker contract', () => {
  afterEach(() => {
    cleanupFixture();
  });

  it('serializes claims and replays only the exact lease outcome before guard settlement', async () => {
    assertNoCalendarAuthorityProject();
    serviceRoleSql(
      `SELECT public.provision_calendar_authority_project_v1(
  :'project_key',
  :'oauth_client_id'
);`,
      {
        oauth_client_id: oauthClientId,
        project_key: projectKey,
      },
    );
    serviceRoleSql(
      `UPDATE private.calendar_authority_projects AS project
SET activation_version = 1,
    activated_at = pg_catalog.clock_timestamp()
WHERE project.project_key = :'project_key';

INSERT INTO auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) VALUES (
  :'user_id'::UUID,
  'authenticated',
  'authenticated',
  :'user_email',
  '',
  '{}'::JSONB,
  '{}'::JSONB,
  pg_catalog.now(),
  pg_catalog.now()
);

SELECT private.get_or_create_calendar_subject_fence_v1(
  :'project_key',
  'calendar-revoke-authority-subject'
);

INSERT INTO public.calendar_connections (
  id,
  user_id,
  provider,
  provider_account_id,
  granted_scopes,
  refresh_token_enc,
  status,
  data_generation,
  authority_fence_id,
  authority_epoch
)
SELECT
  :'connection_id'::UUID,
  :'user_id'::UUID,
  'google',
  'calendar-revoke-authority-subject',
  ARRAY['calendar.readonly']::TEXT[],
  'v1.integration-ciphertext',
  'active',
  0,
  fence.id,
  fence.epoch
FROM private.calendar_authority_fences AS fence
WHERE fence.project_key = :'project_key'
  AND fence.scope_kind = 'subject'
  AND fence.provider_account_id = 'calendar-revoke-authority-subject';

SELECT public.disconnect_calendar_connection_command_v1(
  :'operation_id'::UUID,
  :'project_key',
  :'user_id'::UUID,
  :'connection_id'::UUID
);`,
      {
        connection_id: connectionId,
        oauth_client_id: oauthClientId,
        operation_id: operationId,
        project_key: projectKey,
        user_email: userEmail,
        user_id: userId,
      },
    );

    const [firstWorker, secondWorker] = await Promise.all([claimOne(), claimOne()]);
    const claims = [...firstWorker, ...secondWorker];
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      outbox_id: operationId,
      provider: 'google',
      attempt_count: 1,
    });
    expect(Date.parse(claims[0]!.attempt_deadline_at)).toBeGreaterThan(Date.now());

    const { data: staleResult, error: staleError } = await admin.rpc(
      'finalize_calendar_revoke_attempt_v2',
      {
        p_project_key: projectKey,
        p_outbox_id: operationId,
        p_lease_id: crypto.randomUUID(),
        p_outcome: 'confirmed',
      },
    );
    expect(staleError).toBeNull();
    expect(staleResult).toBe('superseded');

    const firstClaim = claims[0]!;
    const { data: retryResult, error: retryError } = await admin.rpc(
      'finalize_calendar_revoke_attempt_v2',
      {
        p_project_key: projectKey,
        p_outbox_id: operationId,
        p_lease_id: firstClaim.lease_id,
        p_outcome: 'not_started',
      },
    );
    expect(retryError).toBeNull();
    expect(retryResult).toBe('retried');

    ownerSql(
      `UPDATE private.calendar_revoke_outbox
SET available_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
WHERE id = :'operation_id'::UUID;`,
      { operation_id: operationId },
    );

    const reclaimed = await claimOne();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.lease_id).not.toBe(firstClaim.lease_id);
    expect(reclaimed[0]?.attempt_count).toBe(2);

    const finalizationArgs = {
      p_project_key: projectKey,
      p_outbox_id: operationId,
      p_lease_id: reclaimed[0]!.lease_id,
      p_outcome: 'confirmed',
    };
    const { data: confirmed, error: confirmedError } = await admin.rpc(
      'finalize_calendar_revoke_attempt_v2',
      finalizationArgs,
    );
    expect(confirmedError).toBeNull();
    expect(confirmed).toBe('revoke_guarded');

    const { data: replayed, error: replayError } = await admin.rpc(
      'finalize_calendar_revoke_attempt_v2',
      finalizationArgs,
    );
    expect(replayError).toBeNull();
    expect(replayed).toBe('revoke_guarded');
    expect(
      ownerSql(
        `SELECT
  (SELECT pg_catalog.count(*) FROM private.calendar_revoke_outbox
    WHERE id = :'operation_id'::UUID) || '|' ||
  (SELECT state FROM private.calendar_revoke_operations
    WHERE operation_id = :'operation_id'::UUID);`,
        { operation_id: operationId },
      ),
    ).toBe('0|revoke_guarded');

    ownerSql(
      `UPDATE private.calendar_revoke_operations
SET guard_until = pg_catalog.clock_timestamp() - INTERVAL '1 second'
WHERE operation_id = :'operation_id'::UUID;`,
      { operation_id: operationId },
    );
    const { data: guardsFinalized, error: guardError } = await admin.rpc(
      'finalize_calendar_revoke_guards_v1',
      {
        p_project_key: projectKey,
        p_limit: 10,
      },
    );
    expect(guardError).toBeNull();
    expect(guardsFinalized).toBe(1);

    const { data: readiness, error: readinessError } = await admin.rpc(
      'get_calendar_authority_readiness_v1',
      {
        p_project_key: projectKey,
        p_oauth_client_id: oauthClientId,
      },
    );
    expect(readinessError).toBeNull();
    expect(readiness[0]).toMatchObject({
      activated: true,
      pending_operations: 0,
      unbound_connections: 0,
      unbound_outbox: 0,
    });
  });
});
