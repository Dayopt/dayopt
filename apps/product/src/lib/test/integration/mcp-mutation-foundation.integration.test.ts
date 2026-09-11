import { execFileSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { hashToken } from '@/lib/oauth-server';

import { deriveStage1PkceS256Challenge } from './mcp-stage1-crypto';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `mcp-mutation-foundation-${userId}@example.com`;
const password = 'test-password-123';
const resource = 'https://mcp.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));

async function readMutationControl() {
  const { data, error } = await admin
    .from('mcp_mutation_control')
    .select('writes_enabled, enabled_client_ids, revision, changed_at')
    .eq('singleton_key', true)
    .single();
  if (error) throw error;
  return data;
}

async function setClientWriteControl(clientId: 'chatgpt', enabled: boolean) {
  const current = await readMutationControl();
  const { data, error } = await admin.rpc('set_mcp_client_write_control_v1', {
    p_client_id: clientId,
    p_enabled: enabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
  return data[0]!;
}

async function setMutationControl(writesEnabled: boolean) {
  const current = await readMutationControl();
  const { data, error } = await admin.rpc('set_mcp_mutation_control_v1', {
    p_writes_enabled: writesEnabled,
    p_expected_revision: current.revision,
  });
  if (error) throw error;
  return data[0]!;
}

async function createWriteConnection() {
  const { data, error } = await admin.rpc('create_oauth_authorization_grant_v2', {
    p_user_id: userId,
    p_client_id: 'chatgpt',
    p_resource_uri: resource,
    p_scopes: ['read:entries', 'write:plans'],
    p_code_hash: hashToken(`code-${crypto.randomUUID()}`),
    p_redirect_uri: redirectUri,
    p_code_challenge: challenge,
    p_write_enabled: true,
  });
  if (error) throw error;
  return data;
}

/** grant -> code 交換まで通し、apply RPC が要求する (connection, access token) を得る。 */
async function createWriteAuthorization(): Promise<{
  connectionId: string;
  accessTokenId: string;
}> {
  const code = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: resource,
      p_scopes: ['read:entries', 'write:plans'],
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

  return { connectionId, accessTokenId };
}

/** MCP write は利用権（DM005）を要求する。gate の検証に集中するため契約中にしておく。 */
async function entitleUser(): Promise<void> {
  const { error } = await admin
    .from('profiles')
    .update({ subscription_status: 'active' })
    .eq('id', userId);
  if (error) throw error;
}

/**
 * gate の可否だけを見る apply。Plan 同士の重なりは禁止（`plans_no_overlap`）なので、
 * 呼び出しごとに別スロットを使う。
 */
let nextProbeSlotHours = 24;
function applyPlanCreate(authorization: { connectionId: string; accessTokenId: string }) {
  const startHours = nextProbeSlotHours++;
  return admin
    .rpc('apply_mcp_plan_create_v1', {
      p_connection_id: authorization.connectionId,
      p_access_token_id: authorization.accessTokenId,
      p_operation_id: crypto.randomUUID(),
      p_title: `gate probe ${startHours}`,
      p_note: null as never,
      p_start_at: new Date(Date.now() + startHours * 60 * 60_000).toISOString(),
      p_end_at: new Date(Date.now() + (startHours + 0.5) * 60 * 60_000).toISOString(),
    })
    .single();
}

describe.skipIf(!RUN_LOCAL)('MCP mutation foundation integration', () => {
  beforeAll(async () => {
    const { error: createError } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw createError;

    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;

    await setMutationControl(false);
    await setClientWriteControl('chatgpt', false);
  });

  afterAll(async () => {
    await setMutationControl(false);
    await setClientWriteControl('chatgpt', false);
    await userClient.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts fail-closed and exposes only the CAS control RPC', async () => {
    const initial = await readMutationControl();
    expect(initial.writes_enabled).toBe(false);
    expect(initial.enabled_client_ids).toEqual([]);

    const { error: browserReadError } = await userClient
      .from('mcp_mutation_control')
      .select('writes_enabled');
    expect(browserReadError?.code).toBe('42501');

    const { error: directUpdateError } = await admin
      .from('mcp_mutation_control')
      .update({ writes_enabled: true })
      .eq('singleton_key', true);
    expect(directUpdateError?.code).toBe('42501');

    const enabled = await setMutationControl(true);
    expect(enabled).toMatchObject({ writes_enabled: true, revision: initial.revision + 1 });

    const stopped = await setMutationControl(false);
    expect(stopped).toMatchObject({ writes_enabled: false, revision: enabled.revision + 1 });

    const { error: staleEnableError } = await admin.rpc('set_mcp_mutation_control_v1', {
      p_writes_enabled: true,
      p_expected_revision: enabled.revision,
    });
    expect(staleEnableError?.code).toBe('DM001');
    await expect(readMutationControl()).resolves.toMatchObject({
      writes_enabled: false,
      revision: stopped.revision,
    });
  });

  it('requires the durable client gate and retains existing connection metadata', async () => {
    const { error: closedClientError } = await admin.rpc('create_oauth_authorization_grant_v2', {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: resource,
      p_scopes: ['read:entries', 'write:plans'],
      p_code_hash: hashToken(`closed-code-${crypto.randomUUID()}`),
      p_redirect_uri: redirectUri,
      p_code_challenge: challenge,
      p_write_enabled: true,
    });
    expect(closedClientError?.code).toBe('DM003');

    const enabledClient = await setClientWriteControl('chatgpt', true);
    expect(enabledClient.enabled_client_ids).toEqual(['chatgpt']);

    const connectionId = await createWriteConnection();
    const usedAt = new Date().toISOString();

    const { error: usageError } = await admin
      .from('oauth_connections')
      .update({ last_used_at: usedAt })
      .eq('id', connectionId);
    expect(usageError).toBeNull();

    const disabledClient = await setClientWriteControl('chatgpt', false);
    expect(disabledClient.enabled_client_ids).toEqual([]);

    const { data: connection, error: readError } = await admin
      .from('oauth_connections')
      .select('last_used_at, write_enabled_at')
      .eq('id', connectionId)
      .single();
    expect(readError).toBeNull();
    expect(new Date(connection!.last_used_at!).getTime()).toBe(new Date(usedAt).getTime());
    expect(connection?.write_enabled_at).not.toBeNull();
  });

  it('rejects writes once the access token has expired', async () => {
    // 期限切れの access token は `private.authorize_mcp_mutation_v1` の
    // `LEAST(token.expires_at, connection.reauth_required_at) > now()` で落ちる。
    // token 検証はアプリ層（`lib/mcp/auth.ts`）にもあるが、そこを迂回して apply RPC を
    // 直に叩いても通らないことを DB 側で固定する。
    await entitleUser();
    await setMutationControl(true);
    await setClientWriteControl('chatgpt', true);
    const authorization = await createWriteAuthorization();

    const healthy = await applyPlanCreate(authorization);
    expect(healthy.error).toBeNull();

    const { error: expireError } = await admin
      .from('oauth_tokens')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', authorization.accessTokenId);
    expect(expireError).toBeNull();

    const expired = await applyPlanCreate(authorization);
    expect(expired.error?.code).toBe('DM004');

    await setClientWriteControl('chatgpt', false);
    await setMutationControl(false);
  });

  it('keeps the global switch authoritative even when the client is allowed', async () => {
    // grant 時の RPC は `enabled_client_ids` しか見ず、`writes_enabled` は見ない
    // （#2721 D-12 の非対称）。global を落とした状態で client だけ許可しても、
    // 実行時の `authorize_mcp_mutation_v1` が DM003 で止めることを固定する。
    await entitleUser();
    await setMutationControl(true);
    await setClientWriteControl('chatgpt', true);
    const authorization = await createWriteAuthorization();
    expect((await applyPlanCreate(authorization)).error).toBeNull();

    const stopped = await setMutationControl(false);
    expect(stopped.writes_enabled).toBe(false);
    const current = await readMutationControl();
    // client 側の allowlist は開いたまま = global だけが閉じている状態。
    expect(current.enabled_client_ids).toEqual(['chatgpt']);

    const blocked = await applyPlanCreate(authorization);
    expect(blocked.error?.code).toBe('DM003');

    await setClientWriteControl('chatgpt', false);
  });

  it('keeps authoritative receipts payload-free and non-forgeable', async () => {
    const operationId = crypto.randomUUID();
    const { error: browserReadError } = await userClient
      .from('mcp_mutation_receipts')
      .select('operation_id');
    expect(browserReadError?.code).toBe('42501');

    const { error: forgedReceiptError } = await admin.from('mcp_mutation_receipts').insert({
      user_id: userId,
      client_id: 'chatgpt',
      operation_id: operationId,
      envelope_version: 1,
      tool_name: 'plans.create',
      request_digest: `\\x${'00'.repeat(32)}`,
      resource_type: 'plan',
      resource_id: crypto.randomUUID(),
      resource_version: new Date().toISOString(),
    });
    expect(forgedReceiptError?.code).toBe('42501');

    const { data: deleted, error: cleanupError } = await admin.rpc(
      'cleanup_mcp_mutation_receipts_v1',
      { p_limit: 100 },
    );
    expect(cleanupError).toBeNull();
    expect(deleted).toBe(0);
  });

  it('preserves receipts on connection detach and cascades them on account deletion', () => {
    const sql = `
      DO $$
      DECLARE
        v_user_id UUID := gen_random_uuid();
        v_connection_id UUID;
        v_operation_id UUID := gen_random_uuid();
        v_update_rejected BOOLEAN := false;
      BEGIN
        INSERT INTO auth.users (
          id, aud, role, email, encrypted_password, raw_app_meta_data,
          raw_user_meta_data, created_at, updated_at
        ) VALUES (
          v_user_id, 'authenticated', 'authenticated',
          'mcp-receipt-fk-' || v_user_id::TEXT || '@example.com', '', '{}'::JSONB,
          '{}'::JSONB, pg_catalog.now(), pg_catalog.now()
        );

        INSERT INTO public.oauth_connections (
          user_id, client_id, resource_uri, scopes, write_enabled_at
        ) VALUES (
          v_user_id, 'chatgpt', 'https://mcp.dayopt.app',
          ARRAY['read:entries', 'write:plans']::TEXT[], pg_catalog.now()
        ) RETURNING id INTO v_connection_id;

        INSERT INTO public.mcp_mutation_receipts (
          user_id, client_id, operation_id, origin_connection_id,
          envelope_version, tool_name, request_digest, resource_type,
          resource_id, resource_version
        ) VALUES (
          v_user_id, 'chatgpt', v_operation_id, v_connection_id,
          1, 'plans.create', decode(repeat('00', 32), 'hex'), 'plan',
          gen_random_uuid(), pg_catalog.now()
        );

        DELETE FROM public.oauth_connections WHERE id = v_connection_id;

        IF NOT EXISTS (
          SELECT 1 FROM public.mcp_mutation_receipts
          WHERE user_id = v_user_id
            AND operation_id = v_operation_id
            AND origin_connection_id IS NULL
        ) THEN
          RAISE EXCEPTION 'FK detach did not preserve the receipt';
        END IF;

        BEGIN
          UPDATE public.mcp_mutation_receipts
          SET tool_name = 'plans.update'
          WHERE user_id = v_user_id AND operation_id = v_operation_id;
        EXCEPTION WHEN check_violation THEN
          v_update_rejected := true;
        END;

        IF NOT v_update_rejected THEN
          RAISE EXCEPTION 'Receipt mutation was not rejected';
        END IF;

        DELETE FROM auth.users WHERE id = v_user_id;

        IF EXISTS (
          SELECT 1 FROM public.mcp_mutation_receipts
          WHERE user_id = v_user_id
        ) THEN
          RAISE EXCEPTION 'Account cascade left a receipt';
        END IF;
      END;
      $$;
    `;

    expect(() =>
      execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1'], {
        env: {
          ...process.env,
          PGHOST: '127.0.0.1',
          PGPORT: '54322',
          PGDATABASE: 'postgres',
          PGUSER: 'postgres',
          PGPASSWORD: 'postgres',
        },
        input: sql,
        encoding: 'utf8',
      }),
    ).not.toThrow();
  });
});
