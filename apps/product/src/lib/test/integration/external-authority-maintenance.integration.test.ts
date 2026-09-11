import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authenticated = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    // New local Supabase projects expose asymmetric JWT keys. The legacy anon
    // API key remains valid at the gateway, but must not also be presented as
    // a Bearer JWT when this client intentionally exercises the anon DB role.
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('Authorization');
      return fetch(input, { ...init, headers });
    },
  },
});

const userId = crypto.randomUUID();
const userEmail = `external-authority-maintenance-${userId}@example.com`;
const password = 'test-password-123';
const resourceUri = 'https://mcp.dayopt.app';

function ownerSql(sql: string): string {
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
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      sql,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: 'postgres' },
    },
  );

  if (result.status !== 0) {
    throw new Error(`owner SQL failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function insertOutbox(params: {
  id?: string;
  sourceId?: string;
  ciphertext: string;
  createdAt?: string;
  availableAt?: string;
  expiresAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
}): string {
  const id = params.id ?? crypto.randomUUID();
  const sourceId = params.sourceId ?? crypto.randomUUID();
  const createdAt = params.createdAt ?? new Date(Date.now() - 60_000).toISOString();
  const availableAt = params.availableAt ?? new Date(Date.now() - 30_000).toISOString();
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString();
  const lease = params.leaseId
    ? `'${params.leaseId}'::UUID, '${params.leaseExpiresAt}'::TIMESTAMPTZ`
    : 'NULL, NULL';

  ownerSql(`
    INSERT INTO private.calendar_revoke_outbox (
      id,
      user_id,
      source_connection_id,
      provider,
      refresh_token_enc,
      available_at,
      lease_id,
      lease_expires_at,
      created_at,
      expires_at
    ) VALUES (
      '${id}'::UUID,
      '${userId}'::UUID,
      '${sourceId}'::UUID,
      'google',
      '${params.ciphertext}',
      '${availableAt}'::TIMESTAMPTZ,
      ${lease},
      '${createdAt}'::TIMESTAMPTZ,
      '${expiresAt}'::TIMESTAMPTZ
    );
  `);
  return id;
}

async function claim(limit = 20) {
  const { data, error } = await admin.rpc('claim_calendar_revoke_outbox_v1', {
    p_limit: limit,
  });
  if (error) throw error;
  return data;
}

describe.skipIf(!RUN_LOCAL)('external authority maintenance', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email: userEmail,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const { error: signInError } = await authenticated.auth.signInWithPassword({
      email: userEmail,
      password,
    });
    if (signInError) throw signInError;
  });

  afterEach(() => {
    ownerSql(`
      DELETE FROM private.calendar_revoke_outbox WHERE user_id = '${userId}'::UUID;
      DELETE FROM private.integration_security_events WHERE user_id = '${userId}'::UUID;
      DELETE FROM public.mcp_mutation_receipts WHERE user_id = '${userId}'::UUID;
      DELETE FROM public.oauth_authorization_codes WHERE user_id = '${userId}'::UUID;
      DELETE FROM public.oauth_tokens WHERE user_id = '${userId}'::UUID;
      DELETE FROM public.oauth_connections WHERE user_id = '${userId}'::UUID;
    `);
  });

  afterAll(async () => {
    await authenticated.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  it('terminal markerはservice roleだけへCandidate 3 versionを返す', async () => {
    const { data, error } = await admin.rpc('get_external_lifecycle_app_version_v2');
    expect(error).toBeNull();
    expect(data).toBe(1);

    const { error: anonymousError } = await anonymous.rpc('get_external_lifecycle_app_version_v2');
    expect(anonymousError?.code).toBe('42501');

    const { error: authenticatedError } = await authenticated.rpc(
      'get_external_lifecycle_app_version_v2',
    );
    expect(authenticatedError?.code).toBe('42501');
  });

  it('claims each encrypted authority once, recovers an expired lease, and rejects stale completion', async () => {
    const sharedSourceId = crypto.randomUUID();
    const firstId = insertOutbox({
      sourceId: sharedSourceId,
      ciphertext: 'v1.first.ciphertext.payload',
    });
    const secondId = insertOutbox({
      sourceId: sharedSourceId,
      ciphertext: 'v1.second.ciphertext.payload',
    });

    const [firstWorker, secondWorker] = await Promise.all([claim(1), claim(1)]);
    const claimed = [...firstWorker, ...secondWorker];

    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((entry) => entry.outbox_id))).toEqual(new Set([firstId, secondId]));
    expect(new Set(claimed.map((entry) => entry.lease_id)).size).toBe(2);
    await expect(claim(1)).resolves.toEqual([]);

    const { data: leasedStatus, error: leasedStatusError } = await admin.rpc(
      'get_external_authority_maintenance_status_v1',
    );
    expect(leasedStatusError).toBeNull();
    expect(leasedStatus[0]).toMatchObject({
      calendar_revoke_due: 0,
      calendar_revoke_total: 2,
      oldest_due_age_seconds: 0,
    });

    const firstClaim = claimed[0]!;
    const { data: staleCompletion, error: staleCompletionError } = await admin.rpc(
      'complete_calendar_revoke_outbox_v1',
      {
        p_outbox_id: firstClaim.outbox_id,
        p_lease_id: crypto.randomUUID(),
      },
    );
    expect(staleCompletionError).toBeNull();
    expect(staleCompletion).toBe(false);

    const { data: retryResult, error: retryError } = await admin.rpc(
      'retry_calendar_revoke_outbox_v1',
      {
        p_outbox_id: firstClaim.outbox_id,
        p_lease_id: firstClaim.lease_id,
      },
    );
    expect(retryError).toBeNull();
    expect(retryResult).toBe('retried');
    expect(
      ownerSql(`
        SELECT
          lease_id IS NULL AND lease_expires_at IS NULL,
          available_at > pg_catalog.clock_timestamp()
            AND available_at <= pg_catalog.clock_timestamp() + INTERVAL '40 seconds',
          attempt_count
        FROM private.calendar_revoke_outbox
        WHERE id = '${firstClaim.outbox_id}'::UUID;
      `),
    ).toBe('t|t|1');

    const secondClaim = claimed[1]!;
    const { data: completed, error: completionError } = await admin.rpc(
      'complete_calendar_revoke_outbox_v1',
      {
        p_outbox_id: secondClaim.outbox_id,
        p_lease_id: secondClaim.lease_id,
      },
    );
    expect(completionError).toBeNull();
    expect(completed).toBe(true);

    const expiredLeaseId = crypto.randomUUID();
    ownerSql(`
      UPDATE private.calendar_revoke_outbox
      SET available_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
          lease_id = '${expiredLeaseId}'::UUID,
          lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${firstClaim.outbox_id}'::UUID;
    `);

    const recovered = await claim(1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.outbox_id).toBe(firstClaim.outbox_id);
    expect(recovered[0]?.lease_id).not.toBe(expiredLeaseId);
    expect(recovered[0]?.attempt_count).toBe(2);

    const { data: reclaimedStaleCompletion, error: reclaimedStaleCompletionError } =
      await admin.rpc('complete_calendar_revoke_outbox_v1', {
        p_outbox_id: recovered[0]!.outbox_id,
        p_lease_id: expiredLeaseId,
      });
    expect(reclaimedStaleCompletionError).toBeNull();
    expect(reclaimedStaleCompletion).toBe(false);

    const { data: recoveredCompletion, error: recoveredCompletionError } = await admin.rpc(
      'complete_calendar_revoke_outbox_v1',
      {
        p_outbox_id: recovered[0]!.outbox_id,
        p_lease_id: recovered[0]!.lease_id,
      },
    );
    expect(recoveredCompletionError).toBeNull();
    expect(recoveredCompletion).toBe(true);
    expect(ownerSql(`SELECT pg_catalog.count(*) FROM private.calendar_revoke_outbox;`)).toBe('0');
  });

  it('removes expired ciphertext even under an active lease and keeps only a payload-free event', async () => {
    const activeLeaseId = crypto.randomUUID();
    const expiredId = insertOutbox({
      ciphertext: 'v1.expired.ciphertext.payload',
      createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      availableAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      leaseId: activeLeaseId,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const { error: expiryError } = await admin.rpc('expire_calendar_revoke_outbox_v1', {
      p_limit: 100,
    });
    expect(expiryError).toBeNull();

    expect(
      ownerSql(`
        SELECT
          (SELECT pg_catalog.count(*) FROM private.calendar_revoke_outbox WHERE id = '${expiredId}'::UUID),
          (
            SELECT pg_catalog.count(*)
            FROM private.integration_security_events
            WHERE user_id = '${userId}'::UUID
              AND event_kind = 'calendar_revoke_expired'
          );
      `),
    ).toBe('0|1');

    const clampedId = insertOutbox({
      ciphertext: 'v1.clamped.ciphertext.payload',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
    });
    const retentionSeconds = Number(
      ownerSql(`
        SELECT pg_catalog.floor(
          pg_catalog.date_part('epoch', expires_at - created_at)
        )::BIGINT
        FROM private.calendar_revoke_outbox
        WHERE id = '${clampedId}'::UUID;
      `),
    );
    expect(retentionSeconds).toBeGreaterThanOrEqual(86_300);
    expect(retentionSeconds).toBeLessThan(86_400);

    expect(
      ownerSql(`
        SELECT schedule || '|' || command
        FROM cron.job
        WHERE jobname = 'expire-calendar-revoke-outbox';
      `),
    ).toBe('* * * * *|SELECT private.expire_calendar_revoke_outbox_internal_v1(1000)');
  });

  it('cleans OAuth retention and payload-free security events', async () => {
    const activeConnectionId = crypto.randomUUID();
    const dueConnectionId = crypto.randomUUID();
    const oldCodeHash = `old-code-${crypto.randomUUID()}`;
    const freshCodeHash = `fresh-code-${crypto.randomUUID()}`;
    const oldAccessId = crypto.randomUUID();
    const freshAccessId = crypto.randomUUID();
    const oldRefreshId = crypto.randomUUID();
    const freshRefreshId = crypto.randomUUID();
    const dueConnectionReceiptOperationId = crypto.randomUUID();

    ownerSql(`
      INSERT INTO public.oauth_connections (
        id,
        user_id,
        client_id,
        resource_uri,
        scopes,
        authorized_at,
        reauth_required_at,
        revoked_at,
        revoked_reason
      ) VALUES
      (
        '${activeConnectionId}'::UUID,
        '${userId}'::UUID,
        'chatgpt',
        '${resourceUri}',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '1 day',
        pg_catalog.clock_timestamp() + INTERVAL '89 days',
        NULL,
        NULL
      ),
      (
        '${dueConnectionId}'::UUID,
        '${userId}'::UUID,
        'cursor',
        '${resourceUri}',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '200 days',
        pg_catalog.clock_timestamp() - INTERVAL '100 days',
        pg_catalog.clock_timestamp() - INTERVAL '91 days',
        'user_revoked'
      );

      INSERT INTO public.oauth_authorization_codes (
        code_hash,
        user_id,
        client_id,
        redirect_uri,
        code_challenge,
        code_challenge_method,
        scopes,
        connection_id,
        resource_uri,
        expires_at,
        consumed_at
      ) VALUES
      (
        '${oldCodeHash}',
        '${userId}'::UUID,
        'chatgpt',
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'challenge',
        'S256',
        ARRAY['read:entries']::TEXT[],
        '${activeConnectionId}'::UUID,
        '${resourceUri}',
        pg_catalog.clock_timestamp() - INTERVAL '26 hours',
        pg_catalog.clock_timestamp() - INTERVAL '25 hours'
      ),
      (
        '${freshCodeHash}',
        '${userId}'::UUID,
        'chatgpt',
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'challenge',
        'S256',
        ARRAY['read:entries']::TEXT[],
        '${activeConnectionId}'::UUID,
        '${resourceUri}',
        pg_catalog.clock_timestamp() - INTERVAL '24 hours',
        pg_catalog.clock_timestamp() - INTERVAL '23 hours'
      );

      INSERT INTO public.oauth_tokens (
        id,
        user_id,
        token_hash,
        token_type,
        client_id,
        scopes,
        expires_at,
        revoked_at,
        rotated_at,
        connection_id,
        resource_uri
      ) VALUES
      (
        '${oldAccessId}'::UUID,
        '${userId}'::UUID,
        'old-access-${crypto.randomUUID()}',
        'access',
        'chatgpt',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '25 hours',
        NULL,
        NULL,
        '${activeConnectionId}'::UUID,
        '${resourceUri}'
      ),
      (
        '${freshAccessId}'::UUID,
        '${userId}'::UUID,
        'fresh-access-${crypto.randomUUID()}',
        'access',
        'chatgpt',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '23 hours',
        NULL,
        NULL,
        '${activeConnectionId}'::UUID,
        '${resourceUri}'
      ),
      (
        '${oldRefreshId}'::UUID,
        '${userId}'::UUID,
        'old-refresh-${crypto.randomUUID()}',
        'refresh',
        'chatgpt',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() + INTERVAL '1 day',
        pg_catalog.clock_timestamp() - INTERVAL '31 days',
        pg_catalog.clock_timestamp() - INTERVAL '31 days',
        '${activeConnectionId}'::UUID,
        '${resourceUri}'
      ),
      (
        '${freshRefreshId}'::UUID,
        '${userId}'::UUID,
        'fresh-refresh-${crypto.randomUUID()}',
        'refresh',
        'chatgpt',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() + INTERVAL '1 day',
        NULL,
        NULL,
        '${activeConnectionId}'::UUID,
        '${resourceUri}'
      );

      INSERT INTO private.integration_security_events (
        user_id,
        event_kind,
        occurred_at
      ) VALUES
      (
        '${userId}'::UUID,
        'user_data_purged',
        pg_catalog.clock_timestamp() - INTERVAL '91 days'
      ),
      (
        '${userId}'::UUID,
        'user_data_purged',
        pg_catalog.clock_timestamp() - INTERVAL '89 days'
      );

      INSERT INTO public.mcp_mutation_receipts (
        user_id,
        client_id,
        operation_id,
        origin_connection_id,
        envelope_version,
        tool_name,
        request_digest,
        resource_type,
        resource_id,
        resource_version
      ) VALUES (
        '${userId}'::UUID,
        'cursor',
        '${dueConnectionReceiptOperationId}'::UUID,
        '${dueConnectionId}'::UUID,
        1,
        'plans.create',
        decode(repeat('00', 32), 'hex'),
        'plan',
        gen_random_uuid(),
        pg_catalog.clock_timestamp()
      );
    `);

    const { data: before, error: beforeError } = await admin.rpc(
      'get_external_authority_maintenance_status_v1',
    );
    expect(beforeError).toBeNull();
    expect(before[0]).toMatchObject({
      authorization_codes_due: true,
      access_tokens_due: true,
      refresh_tokens_due: true,
      connections_due: true,
      security_events_due: true,
    });

    const codeCleanup = await admin.rpc('cleanup_oauth_authorization_codes_v1', {
      p_limit: 100,
    });
    expect(codeCleanup.error).toBeNull();
    expect(codeCleanup.data).toBe(1);

    const accessCleanup = await admin.rpc('cleanup_oauth_access_tokens_v1', { p_limit: 100 });
    expect(accessCleanup.error).toBeNull();
    expect(accessCleanup.data).toBe(1);

    const refreshCleanup = await admin.rpc('cleanup_oauth_refresh_tokens_v1', { p_limit: 100 });
    expect(refreshCleanup.error).toBeNull();
    expect(refreshCleanup.data).toBe(1);

    const connectionCleanup = await admin.rpc('cleanup_oauth_connections_v1', { p_limit: 100 });
    expect(connectionCleanup.error).toBeNull();
    expect(connectionCleanup.data).toBe(1);

    const securityEventCleanup = await admin.rpc('cleanup_integration_security_events_v1', {
      p_limit: 1,
    });
    expect(securityEventCleanup.error).toBeNull();
    expect(securityEventCleanup.data).toBe(1);

    expect(
      ownerSql(`
        SELECT
          EXISTS (
            SELECT 1 FROM public.oauth_authorization_codes
            WHERE code_hash = '${oldCodeHash}'
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_authorization_codes
            WHERE code_hash = '${freshCodeHash}'
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_tokens
            WHERE id = '${oldAccessId}'::UUID
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_tokens
            WHERE id = '${freshAccessId}'::UUID
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_tokens
            WHERE id = '${oldRefreshId}'::UUID
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_tokens
            WHERE id = '${freshRefreshId}'::UUID
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_connections
            WHERE id = '${dueConnectionId}'::UUID
          ),
          EXISTS (
            SELECT 1 FROM public.oauth_connections
            WHERE id = '${activeConnectionId}'::UUID
          ),
          (
            -- 回帰確認: due connection の cleanup は紐づく receipt を削除せず
            -- origin_connection_id だけを NULL 化する(private.enforce_mcp_mutation_receipt_
            -- lifecycle_v1() が明示的に許可している detach)。この trigger の許可が将来壊れると
            -- cleanup_oauth_connections_v1 の DELETE 自体が例外で失敗するので、その回帰は
            -- ここでしか検出できない。
            SELECT origin_connection_id IS NULL
            FROM public.mcp_mutation_receipts
            WHERE operation_id = '${dueConnectionReceiptOperationId}'::UUID
          );
      `),
    ).toBe('f|t|f|t|f|t|f|t|t');

    expect(
      ownerSql(`
        SELECT
          pg_catalog.count(*) FILTER (
            WHERE occurred_at <= pg_catalog.clock_timestamp() - INTERVAL '90 days'
          ),
          pg_catalog.count(*) FILTER (
            WHERE occurred_at > pg_catalog.clock_timestamp() - INTERVAL '90 days'
          )
        FROM private.integration_security_events
        WHERE user_id = '${userId}'::UUID;
      `),
    ).toBe('0|1');

    const { data: after, error: afterError } = await admin.rpc(
      'get_external_authority_maintenance_status_v1',
    );
    expect(afterError).toBeNull();
    expect(after[0]).toMatchObject({
      authorization_codes_due: false,
      access_tokens_due: false,
      refresh_tokens_due: false,
      connections_due: false,
      security_events_due: false,
    });
  });

  it('p_limit を超える backlog は1回の呼び出しでp_limit件だけ削除して止まる', async () => {
    const connectionId = crypto.randomUUID();
    const dueRefreshIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    ownerSql(`
      INSERT INTO public.oauth_connections (
        id, user_id, client_id, resource_uri, scopes,
        authorized_at, reauth_required_at
      ) VALUES (
        '${connectionId}'::UUID, '${userId}'::UUID, 'chatgpt', '${resourceUri}',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + INTERVAL '89 days'
      );

      INSERT INTO public.oauth_tokens (
        id, user_id, token_hash, token_type, client_id, scopes,
        expires_at, revoked_at, rotated_at, connection_id, resource_uri
      ) VALUES
      -- oauth_tokens_rotation_shape（20260729062430）は rotated_at を立てた refresh token に
      -- revoked_at も要求する。rotation は旧 token の失効を伴うため、fixture もその形にする。
      -- refresh の due 判定は LEAST(expires_at, rotated_at, revoked_at) なので、両者を同値に
      -- しておけば cutoff 判定と削除順は rotated_at の値のまま決まる。
      (
        '${dueRefreshIds[0]}'::UUID, '${userId}'::UUID, 'limit-refresh-0-${crypto.randomUUID()}',
        'refresh', 'chatgpt', ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() + INTERVAL '1 day',
        pg_catalog.clock_timestamp() - INTERVAL '31 days',
        pg_catalog.clock_timestamp() - INTERVAL '31 days',
        '${connectionId}'::UUID, '${resourceUri}'
      ),
      (
        '${dueRefreshIds[1]}'::UUID, '${userId}'::UUID, 'limit-refresh-1-${crypto.randomUUID()}',
        'refresh', 'chatgpt', ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() + INTERVAL '1 day',
        pg_catalog.clock_timestamp() - INTERVAL '32 days',
        pg_catalog.clock_timestamp() - INTERVAL '32 days',
        '${connectionId}'::UUID, '${resourceUri}'
      ),
      (
        '${dueRefreshIds[2]}'::UUID, '${userId}'::UUID, 'limit-refresh-2-${crypto.randomUUID()}',
        'refresh', 'chatgpt', ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() + INTERVAL '1 day',
        pg_catalog.clock_timestamp() - INTERVAL '33 days',
        pg_catalog.clock_timestamp() - INTERVAL '33 days',
        '${connectionId}'::UUID, '${resourceUri}'
      );
    `);

    const countDue = (): number =>
      Number(
        ownerSql(`
          SELECT pg_catalog.count(*)
          FROM public.oauth_tokens
          WHERE token_type = 'refresh'
            AND id = ANY(ARRAY[${dueRefreshIds.map((id) => `'${id}'::UUID`).join(', ')}]);
        `),
      );

    expect(countDue()).toBe(3);

    const first = await admin.rpc('cleanup_oauth_refresh_tokens_v1', { p_limit: 1 });
    expect(first.error).toBeNull();
    expect(first.data).toBe(1);
    expect(countDue()).toBe(2);

    const second = await admin.rpc('cleanup_oauth_refresh_tokens_v1', { p_limit: 1 });
    expect(second.error).toBeNull();
    expect(second.data).toBe(1);
    expect(countDue()).toBe(1);

    const rest = await admin.rpc('cleanup_oauth_refresh_tokens_v1', { p_limit: 100 });
    expect(rest.error).toBeNull();
    expect(rest.data).toBe(1);
    expect(countDue()).toBe(0);
  });

  it('残存する子行を持つ connection は排出が終わるまで削除しない', async () => {
    // p_limit が縛るのは親の件数だけで、ON DELETE CASCADE の子行削除は無制限に走る。
    // 子を抱えた親を消さないことで、1 回の DELETE が RPC timeout を超えるのを防ぐ。
    const connectionId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();

    ownerSql(`
      INSERT INTO public.oauth_connections (
        id, user_id, client_id, resource_uri, scopes,
        authorized_at, reauth_required_at
      ) VALUES (
        '${connectionId}'::UUID, '${userId}'::UUID, 'cursor', '${resourceUri}',
        ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '200 days',
        pg_catalog.clock_timestamp() - INTERVAL '110 days'
      );

      -- 親は due（110 日前に reauth 期限切れ）だが、子の access token がまだ残っている。
      INSERT INTO public.oauth_tokens (
        id, user_id, token_hash, token_type, client_id, scopes,
        expires_at, connection_id, resource_uri
      ) VALUES (
        '${tokenId}'::UUID, '${userId}'::UUID, 'guard-access-${crypto.randomUUID()}',
        'access', 'cursor', ARRAY['read:entries']::TEXT[],
        pg_catalog.clock_timestamp() - INTERVAL '109 days',
        '${connectionId}'::UUID, '${resourceUri}'
      );
    `);

    const blocked = await admin.rpc('cleanup_oauth_connections_v1', { p_limit: 1000 });
    expect(blocked.error).toBeNull();
    expect(
      ownerSql(
        `SELECT EXISTS (SELECT 1 FROM public.oauth_connections WHERE id = '${connectionId}'::UUID);`,
      ),
    ).toBe('t');

    // 子を排出すると、次の実行で親も消える（収束の保証）。
    const drained = await admin.rpc('cleanup_oauth_access_tokens_v1', { p_limit: 1000 });
    expect(drained.error).toBeNull();

    const removed = await admin.rpc('cleanup_oauth_connections_v1', { p_limit: 1000 });
    expect(removed.error).toBeNull();
    expect(
      ownerSql(
        `SELECT EXISTS (SELECT 1 FROM public.oauth_connections WHERE id = '${connectionId}'::UUID);`,
      ),
    ).toBe('f');
  });

  it('does not expose maintenance RPCs to browser roles', async () => {
    for (const client of [anonymous, authenticated]) {
      const results = await Promise.all([
        client.rpc('claim_calendar_revoke_outbox_v1', { p_limit: 1 }),
        client.rpc('complete_calendar_revoke_outbox_v1', {
          p_outbox_id: crypto.randomUUID(),
          p_lease_id: crypto.randomUUID(),
        }),
        client.rpc('retry_calendar_revoke_outbox_v1', {
          p_outbox_id: crypto.randomUUID(),
          p_lease_id: crypto.randomUUID(),
        }),
        client.rpc('expire_calendar_revoke_outbox_v1', { p_limit: 1 }),
        client.rpc('cleanup_oauth_authorization_codes_v1', { p_limit: 1 }),
        client.rpc('cleanup_oauth_access_tokens_v1', { p_limit: 1 }),
        client.rpc('cleanup_oauth_refresh_tokens_v1', { p_limit: 1 }),
        client.rpc('cleanup_oauth_connections_v1', { p_limit: 1 }),
        client.rpc('cleanup_integration_security_events_v1', { p_limit: 1 }),
        client.rpc('get_external_authority_maintenance_status_v1'),
      ]);

      // '42501' を厳密に見る。関数が存在しない場合の PGRST202 でも result.error は非
      // null になるため、緩い not.toBeNull() だと「関数が無いから落ちている」偽陽性を
      // service-role ガードの拒否と区別できない。
      for (const result of results) {
        expect(result.error?.code).toBe('42501');
      }
    }
  });
});
