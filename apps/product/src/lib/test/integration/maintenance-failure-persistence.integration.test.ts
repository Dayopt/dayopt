import { spawnSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database';

const fixtures = vi.hoisted(() => ({
  client: undefined as SupabaseClient<Database> | undefined,
  revoke: vi.fn(async () => true),
  key: Buffer.alloc(32, 7).toString('base64'),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: { CALENDAR_TOKEN_ENCRYPTION_KEY: fixtures.key } }));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => {
    if (!fixtures.client) throw new Error('Isolated client is not initialized');
    return fixtures.client;
  },
}));
vi.mock('@/features/external-calendar/server/providers/google', () => ({
  googleCalendarAdapter: { revoke: fixtures.revoke },
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: vi.fn(),
  captureUnexpectedDatabaseError: vi.fn(),
}));

import { dispatchExternalConnectionMaintenance } from '@/app/api/cron/external-connection-maintenance/_composition/maintenance-dispatcher';
import { encryptToken } from '@/features/external-calendar/server/token-crypto';

const runLocal = process.env.USE_LOCAL_DB === 'true';
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const dbPort = process.env.ISOLATED_DB_PORT ?? '54322';
const userId = crypto.randomUUID();
const outboxId = crypto.randomUUID();
const sourceId = crypto.randomUUID();
let injectedFailures = 0;

function ownerSql(sql: string) {
  const parsed = new URL(apiUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !['54322', '56322'].includes(dbPort) ||
    Number(parsed.port) + 1 !== Number(dbPort)
  ) {
    throw new Error('This maintenance fixture requires the isolated local database');
  }
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      dbPort,
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  if (result.status !== 0) throw new Error('Isolated owner SQL failed: ' + result.stderr);
  return result.stdout.trim();
}

describe.skipIf(!runLocal)('maintenance failure preserves completed revoke', () => {
  beforeAll(async () => {
    ownerSql('SELECT 1');
    fixtures.client = createClient<Database>(apiUrl, process.env.SUPABASE_SECRET_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: async (input, init) => {
          const target = input instanceof Request ? input.url : String(input);
          if (!target.startsWith(apiUrl + '/')) throw new Error('Unexpected external request');
          if (target.endsWith('/rpc/cleanup_integration_security_events_v1')) {
            // mock応答ではなく、実Postgresが拒否する引数でcleanupを失敗させる。
            const response = await fetch(input, {
              ...init,
              body: JSON.stringify({ p_limit: 'invalid-integer' }),
            });
            const failure: { code?: string } = await response.clone().json();
            expect(failure.code).toBe('22P02');
            injectedFailures += 1;
            return response;
          }
          return fetch(input, init);
        },
      },
    });
    const { error } = await fixtures.client.auth.admin.createUser({
      id: userId,
      email: 'maintenance-persistence-' + userId + '@example.com',
      password: 'Isolated-fixture-password-123',
      email_confirm: true,
    });
    if (error) throw error;
    const ciphertext = encryptToken('isolated-revoke-token', fixtures.key);
    ownerSql(`INSERT INTO private.calendar_revoke_outbox
      (id,user_id,source_connection_id,provider,refresh_token_enc,available_at,created_at,expires_at)
      VALUES ('${outboxId}','${userId}','${sourceId}','google','${ciphertext}',
        now()-interval '30 seconds',now()-interval '60 seconds',now()+interval '1 hour')`);
  });

  afterAll(async () => {
    ownerSql(`DELETE FROM private.calendar_revoke_outbox WHERE id='${outboxId}';
      DELETE FROM private.integration_security_events WHERE user_id='${userId}'`);
    if (fixtures.client) {
      const { error } = await fixtures.client.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
  });

  it('real claim/complete stays committed after the later cleanup SQL error; retry does not revoke twice', async () => {
    expect(
      ownerSql(`SELECT count(*) FROM private.calendar_revoke_outbox WHERE id='${outboxId}'`),
    ).toBe('1');
    await expect(
      dispatchExternalConnectionMaintenance({ deadlineAt: Date.now() + 90_000 }),
    ).rejects.toMatchObject({ name: 'ExternalConnectionMaintenanceError' });
    expect(injectedFailures).toBe(1);
    expect(fixtures.revoke).toHaveBeenCalledExactlyOnceWith('isolated-revoke-token');
    expect(
      ownerSql(`SELECT count(*) FROM private.calendar_revoke_outbox WHERE id='${outboxId}'`),
    ).toBe('0');
    await expect(
      dispatchExternalConnectionMaintenance({ deadlineAt: Date.now() + 90_000 }),
    ).rejects.toMatchObject({ name: 'ExternalConnectionMaintenanceError' });
    expect(injectedFailures).toBe(2);
    expect(fixtures.revoke).toHaveBeenCalledTimes(1);
    expect(
      ownerSql(`SELECT count(*) FROM private.calendar_revoke_outbox WHERE id='${outboxId}'`),
    ).toBe('0');
  });
});
