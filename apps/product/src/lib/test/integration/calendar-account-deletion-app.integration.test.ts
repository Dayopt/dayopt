import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCalendarAccountDeletionService } from '@/features/external-calendar/server/account-deletion';
import { encryptToken } from '@/features/external-calendar/server/token-crypto';
import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');

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
const oauthClientId = `${projectKey}-accountdelete.apps.googleusercontent.com`;
const accountUserId = crypto.randomUUID();
const purgeUserId = crypto.randomUUID();
const accountConnectionId = crypto.randomUUID();
const purgeConnectionId = crypto.randomUUID();

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
    throw new Error(`Calendar account deletion app SQL failed: ${result.stderr}`);
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
    throw new Error('Calendar account deletion fixture requires an empty authority singleton');
  }
}

function cleanupFixture(): void {
  ownerSql(
    `DELETE FROM private.calendar_account_deletion_intents
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.calendar_revoke_outbox
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.calendar_authority_command_receipts
WHERE source_user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.calendar_revoke_operations
WHERE source_user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID)
   OR source_connection_id IN (
     :'account_connection_id'::UUID,
     :'purge_connection_id'::UUID
   );
DELETE FROM private.integration_security_events
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.calendar_oauth_attempts
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM public.external_calendar_events
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM public.calendar_connections
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM public.plans
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.user_data_controls
WHERE user_id IN (:'account_user_id'::UUID, :'purge_user_id'::UUID);
DELETE FROM private.calendar_authority_fences
WHERE project_key = :'project_key';
DELETE FROM private.calendar_authority_projects
WHERE project_key = :'project_key';`,
    {
      account_connection_id: accountConnectionId,
      account_user_id: accountUserId,
      project_key: projectKey,
      purge_connection_id: purgeConnectionId,
      purge_user_id: purgeUserId,
    },
  );
  ownerSql(`DELETE FROM auth.users WHERE id = :'user_id'::UUID;`, {
    user_id: accountUserId,
  });
  ownerSql(`DELETE FROM auth.users WHERE id = :'user_id'::UUID;`, {
    user_id: purgeUserId,
  });
}

describe.skipIf(!RUN_LOCAL)('Calendar account deletion app adapter', () => {
  afterEach(() => {
    cleanupFixture();
  });

  it('replay-safe v5 purgeとsealed identity deletionを実DB contractへ接続する', async () => {
    assertNoCalendarAuthorityProject();
    const accountToken = 'account-delete-refresh-token';
    const purgeToken = 'purge-refresh-token';
    const generatedIds = [crypto.randomUUID(), crypto.randomUUID()];

    serviceRoleSql(
      `SELECT public.provision_calendar_authority_project_v1(
  :'project_key',
  :'oauth_client_id'
);

UPDATE private.calendar_authority_projects AS project
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
) VALUES
(
  :'account_user_id'::UUID,
  'authenticated',
  'authenticated',
  'calendar-account-delete@example.com',
  '',
  '{}'::JSONB,
  '{}'::JSONB,
  pg_catalog.now(),
  pg_catalog.now()
),
(
  :'purge_user_id'::UUID,
  'authenticated',
  'authenticated',
  'calendar-purge@example.com',
  '',
  '{}'::JSONB,
  '{}'::JSONB,
  pg_catalog.now(),
  pg_catalog.now()
);

SELECT private.get_or_create_calendar_subject_fence_v1(
  :'project_key',
  'account-delete-subject'
);
SELECT private.get_or_create_calendar_subject_fence_v1(
  :'project_key',
  'purge-subject'
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
  fixture.connection_id,
  fixture.user_id,
  'google',
  fixture.provider_account_id,
  ARRAY['calendar.readonly']::TEXT[],
  fixture.refresh_token_enc,
  'active',
  0,
  fence.id,
  fence.epoch
FROM (
  VALUES
    (
      :'account_connection_id'::UUID,
      :'account_user_id'::UUID,
      'account-delete-subject'::TEXT,
      :'account_token_enc'::TEXT
    ),
    (
      :'purge_connection_id'::UUID,
      :'purge_user_id'::UUID,
      'purge-subject'::TEXT,
      :'purge_token_enc'::TEXT
    )
) AS fixture(connection_id, user_id, provider_account_id, refresh_token_enc)
JOIN private.calendar_authority_fences AS fence
  ON fence.project_key = :'project_key'
 AND fence.scope_kind = 'subject'
 AND fence.provider_account_id = fixture.provider_account_id;

INSERT INTO public.plans (
  user_id,
  title,
  start_at,
  end_at
) VALUES (
  :'purge_user_id'::UUID,
  'purge fixture',
  pg_catalog.clock_timestamp() + INTERVAL '1 day',
  pg_catalog.clock_timestamp() + INTERVAL '1 day 1 hour'
);`,
      {
        account_connection_id: accountConnectionId,
        account_token_enc: encryptToken(accountToken, ENCRYPTION_KEY),
        account_user_id: accountUserId,
        oauth_client_id: oauthClientId,
        project_key: projectKey,
        purge_connection_id: purgeConnectionId,
        purge_token_enc: encryptToken(purgeToken, ENCRYPTION_KEY),
        purge_user_id: purgeUserId,
      },
    );

    const revoke = vi.fn().mockResolvedValue(true);
    const createService = () =>
      createCalendarAccountDeletionService({
        db: admin as never,
        encryptionKey: ENCRYPTION_KEY,
        generateId: () => generatedIds.shift() ?? crypto.randomUUID(),
        identity: { oauthClientId, projectKey },
        now: Date.now,
        provider: { revoke },
      });
    const service = createService();
    const purgePreflight = await service.prepareDeleteAllData({
      userId: purgeUserId,
    });

    await service.deleteAllData({
      ...purgePreflight,
      userId: purgeUserId,
    });

    expect(
      JSON.parse(
        ownerSql(
          `SELECT pg_catalog.jsonb_build_object(
  'connections', (
    SELECT pg_catalog.count(*)
    FROM public.calendar_connections
    WHERE user_id = :'user_id'::UUID
  ),
  'plans', (
    SELECT pg_catalog.count(*)
    FROM public.plans
    WHERE user_id = :'user_id'::UUID
  ),
  'outbox', (
    SELECT pg_catalog.count(*)
    FROM private.calendar_revoke_outbox
    WHERE user_id = :'user_id'::UUID
  ),
  'generation', (
    SELECT generation
    FROM private.user_data_controls
    WHERE user_id = :'user_id'::UUID
  )
)::TEXT;`,
          { user_id: purgeUserId },
        ),
      ),
    ).toEqual({
      connections: 0,
      generation: 1,
      outbox: 1,
      plans: 0,
    });
    expect(revoke).not.toHaveBeenCalled();

    serviceRoleSql(
      `SELECT pg_catalog.count(*)
FROM public.create_plan_command_v1(
  :'user_id'::UUID,
  'created after purge',
  NULL,
  NULL,
  'manual',
  pg_catalog.clock_timestamp() + INTERVAL '2 days',
  pg_catalog.clock_timestamp() + INTERVAL '2 days 1 hour'
);`,
      {
        user_id: purgeUserId,
      },
    );

    await createService().deleteAllData({
      ...purgePreflight,
      userId: purgeUserId,
    });

    expect(
      JSON.parse(
        ownerSql(
          `SELECT pg_catalog.jsonb_build_object(
  'generation', (
    SELECT generation
    FROM private.user_data_controls
    WHERE user_id = :'user_id'::UUID
  ),
  'outbox', (
    SELECT pg_catalog.count(*)
    FROM private.calendar_revoke_outbox
    WHERE user_id = :'user_id'::UUID
  ),
  'plans', (
    SELECT pg_catalog.count(*)
    FROM public.plans
    WHERE user_id = :'user_id'::UUID
  ),
  'purgeOperationMatches', (
    SELECT last_purge_operation_id = :'operation_id'::UUID
    FROM private.user_data_controls
    WHERE user_id = :'user_id'::UUID
  )
)::TEXT;`,
          {
            operation_id: purgePreflight.operationId,
            user_id: purgeUserId,
          },
        ),
      ),
    ).toEqual({
      generation: 1,
      outbox: 1,
      plans: 1,
      purgeOperationMatches: true,
    });

    expect(() =>
      serviceRoleSql(
        `SELECT public.delete_all_user_data_command_v5(
  :'operation_id'::UUID,
  :'expected_generation'::BIGINT,
  :'project_key',
  :'user_id'::UUID
);`,
        {
          expected_generation: purgePreflight.expectedGeneration,
          operation_id: purgePreflight.operationId,
          project_key: `${projectKey}9`,
          user_id: purgeUserId,
        },
      ),
    ).toThrow('Purge operation identity mismatch');

    const nextPurge = await createService().prepareDeleteAllData({
      userId: purgeUserId,
    });
    await createService().deleteAllData({
      ...nextPurge,
      userId: purgeUserId,
    });
    serviceRoleSql(
      `SELECT pg_catalog.count(*)
FROM public.create_plan_command_v1(
  :'user_id'::UUID,
  'created after second purge',
  NULL,
  NULL,
  'manual',
  pg_catalog.clock_timestamp() + INTERVAL '3 days',
  pg_catalog.clock_timestamp() + INTERVAL '3 days 1 hour'
);`,
      { user_id: purgeUserId },
    );

    await expect(
      createService().deleteAllData({
        ...purgePreflight,
        userId: purgeUserId,
      }),
    ).rejects.toMatchObject({
      code: 'CALENDAR_ACCOUNT_DELETION_DELETE_ALL_DATA_FAILED',
    });
    expect(
      JSON.parse(
        ownerSql(
          `SELECT pg_catalog.jsonb_build_object(
  'generation', (
    SELECT generation
    FROM private.user_data_controls
    WHERE user_id = :'user_id'::UUID
  ),
  'plans', (
    SELECT pg_catalog.count(*)
    FROM public.plans
    WHERE user_id = :'user_id'::UUID
  )
)::TEXT;`,
          { user_id: purgeUserId },
        ),
      ),
    ).toEqual({ generation: 2, plans: 1 });

    await service.beforeIdentityDeletion({ userId: accountUserId });

    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(accountToken);
    expect(
      ownerSql(
        `SELECT state
FROM private.calendar_account_deletion_intents
WHERE user_id = :'user_id'::UUID;`,
        { user_id: accountUserId },
      ),
    ).toBe('ready');

    expect(
      ownerSql(
        `DELETE FROM auth.users WHERE id = :'user_id'::UUID;
SELECT pg_catalog.count(*) FROM auth.users WHERE id = :'user_id'::UUID;`,
        {
          user_id: accountUserId,
        },
      ),
    ).toBe('0');
  });
});
