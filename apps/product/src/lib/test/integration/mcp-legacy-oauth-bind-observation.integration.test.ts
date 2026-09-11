import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

/**
 * Stage 8-3 observation window
 * (issue #1754 comment, step-6-candidate-8-cleanup.md §Stage 8-3 equivalent;
 * moved in #2473). bind_legacy_oauth_insert_to_connection() is the compatibility
 * BEFORE INSERT trigger on oauth_authorization_codes / oauth_tokens. Every
 * time it actually backfills connection_id for a legacy (connection_id IS
 * NULL) insert, 20260810013820_observe_legacy_oauth_bind.sql makes it write
 * one append-only row to private.legacy_oauth_bind_observations. This is the
 * primary stop-condition signal for dropping the trigger in Stage 8-3 — it
 * measures use of the DROP target itself, not a downstream proxy.
 *
 * This suite verifies the observation is wired correctly (fires exactly on
 * the backfill branch, not on already-bound inserts) and that the table
 * stays genuinely append-only / redacted (no role but service_role can even
 * see it, and nothing can UPDATE or DELETE it).
 */

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const resourceUri = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `mcp-legacy-bind-observation-${userId}@example.com`;
const password = 'test-password-123';

function runOwnerSql(
  sql: string,
  variables: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(
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
      env: { ...process.env, PGPASSWORD: 'postgres' },
      encoding: 'utf8',
      input: `\\set VERBOSITY verbose\n${sql}`,
    },
  );
}

function observationCount(): number {
  const result = runOwnerSql('SELECT count(*) FROM private.legacy_oauth_bind_observations;');
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

function latestObservations(limit: number): Array<{ sourceTable: string; hadParent: boolean }> {
  const result = runOwnerSql(`
    SELECT source_table || ',' || had_parent::TEXT
    FROM private.legacy_oauth_bind_observations
    ORDER BY id DESC
    LIMIT ${limit};
  `);
  expect(result.status).toBe(0);
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .reverse()
    .map((line) => {
      const [sourceTable, hadParent] = line.split(',');
      return { sourceTable: sourceTable!, hadParent: hadParent === 'true' };
    });
}

/**
 * Attempts one statement as `authenticated` and asserts it is rejected with
 * permission denied (42501). Run as separate invocations (not one script) so
 * one failing statement never masks whether the others were even reached.
 */
function expectAuthenticatedPermissionDenied(sql: string): void {
  const result = runOwnerSql(`
    SET ROLE authenticated;
    ${sql}
  `);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('42501');
  expect(result.stderr).toContain('permission denied');
}

describe.skipIf(!RUN_LOCAL)('Stage 8-3 legacy OAuth bind observation', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(userId);
  });

  it('records one redacted observation row per legacy backfill, and none for an explicit connection_id insert', async () => {
    const before = observationCount();

    const codeHash = `legacy-bind-observation-code-${crypto.randomUUID()}`;
    const { data: code, error: codeError } = await admin
      .from('oauth_authorization_codes')
      .insert({
        user_id: userId,
        client_id: 'chatgpt',
        code_hash: codeHash,
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
        scopes: ['read:entries'],
      })
      .select('code_hash, connection_id')
      .single();
    expect(codeError).toBeNull();
    expect(code?.connection_id).toEqual(expect.any(String));

    const { error: consumeError } = await admin
      .from('oauth_authorization_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('code_hash', codeHash);
    expect(consumeError).toBeNull();

    // Legacy refresh insert (no connection_id, no parent_token_id): binds via
    // the consumed-code family lookup. had_parent must be false.
    const { data: refresh, error: refreshError } = await admin
      .from('oauth_tokens')
      .insert({
        user_id: userId,
        client_id: 'chatgpt',
        token_hash: `legacy-bind-observation-refresh-${crypto.randomUUID()}`,
        token_type: 'refresh',
        scopes: ['read:entries'],
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      })
      .select('id, connection_id')
      .single();
    expect(refreshError).toBeNull();
    expect(refresh?.connection_id).toBe(code?.connection_id);

    // Legacy access insert with parent_token_id: binds via parent
    // inheritance. had_parent must be true.
    const { data: access, error: accessError } = await admin
      .from('oauth_tokens')
      .insert({
        user_id: userId,
        client_id: 'chatgpt',
        token_hash: `legacy-bind-observation-access-${crypto.randomUUID()}`,
        token_type: 'access',
        scopes: ['read:entries'],
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        parent_token_id: refresh!.id,
      })
      .select('id, connection_id')
      .single();
    expect(accessError).toBeNull();
    expect(access?.connection_id).toBe(code?.connection_id);

    const afterLegacy = observationCount();
    expect(afterLegacy - before).toBe(3);
    expect(latestObservations(3)).toEqual([
      { sourceTable: 'oauth_authorization_codes', hadParent: false },
      { sourceTable: 'oauth_tokens', hadParent: false },
      { sourceTable: 'oauth_tokens', hadParent: true },
    ]);

    // Current-runtime insert with an explicit connection_id: the trigger's
    // WHEN (NEW.connection_id IS NULL) clause means it never fires, so no
    // backfill happens and no observation row is written.
    const { error: explicitError } = await admin.from('oauth_tokens').insert({
      user_id: userId,
      client_id: 'chatgpt',
      connection_id: code!.connection_id,
      resource_uri: resourceUri,
      token_hash: `legacy-bind-observation-explicit-${crypto.randomUUID()}`,
      token_type: 'access',
      scopes: ['read:entries'],
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(explicitError).toBeNull();

    const afterExplicit = observationCount();
    expect(afterExplicit).toBe(afterLegacy);
  });

  it('keeps the observation table unreachable and unwritable for authenticated', () => {
    expectAuthenticatedPermissionDenied(
      'SELECT count(*) FROM private.legacy_oauth_bind_observations;',
    );
    expectAuthenticatedPermissionDenied(
      "INSERT INTO private.legacy_oauth_bind_observations (source_table, had_parent) VALUES ('oauth_tokens', false);",
    );
    expectAuthenticatedPermissionDenied(
      'UPDATE private.legacy_oauth_bind_observations SET had_parent = true;',
    );
    expectAuthenticatedPermissionDenied('DELETE FROM private.legacy_oauth_bind_observations;');
  });

  it('grants service_role read-only access and denies UPDATE/DELETE to every role', () => {
    const result = runOwnerSql(`
      SELECT
        pg_catalog.has_table_privilege(
          'service_role',
          'private.legacy_oauth_bind_observations',
          'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'service_role',
          'private.legacy_oauth_bind_observations',
          'INSERT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'service_role',
          'private.legacy_oauth_bind_observations',
          'UPDATE'
        )
        AND NOT pg_catalog.has_table_privilege(
          'service_role',
          'private.legacy_oauth_bind_observations',
          'DELETE'
        )
        AND NOT pg_catalog.has_table_privilege(
          'anon',
          'private.legacy_oauth_bind_observations',
          'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'private.legacy_oauth_bind_observations',
          'SELECT'
        )
        AND NOT pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')
        AND pg_catalog.has_schema_privilege('service_role', 'private', 'USAGE');
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('t');
  });
});
