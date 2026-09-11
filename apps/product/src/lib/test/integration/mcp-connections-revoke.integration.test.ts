import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { hashToken } from '@/lib/oauth-server';

import { deriveStage1PkceS256Challenge } from './mcp-stage1-crypto';

/**
 * Settings 画面の MCP connection revoke（issue #1895）の integration test。
 *
 * `revoke_oauth_connection` RPC そのものは既存機能（20260729062428_mcp_oauth_connections_
 * expand.sql）だが、Settings からの revoke 導線が (a) 自分の connection しか触れない、
 * (b) revoke が同一 connection の全 token を道連れにする、(c) revoke 後は同じ token family
 * が rotation で復活しない、(d) 他人の connection は RLS 越しに見えない、の 4 点を守ることを
 * 確認する。
 */

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ownerClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const otherClient = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const resource = 'https://mcp.dayopt.app';
const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));
const password = 'test-password-123';

const ownerId = crypto.randomUUID();
const ownerEmail = `mcp-connections-revoke-owner-${ownerId}@example.com`;
const otherId = crypto.randomUUID();
const otherEmail = `mcp-connections-revoke-other-${otherId}@example.com`;

interface ConnectionAuthorization {
  connectionId: string;
  /** 生の refresh token（token_hash ではなく rotation RPC にそのまま渡す値）。 */
  refreshToken: string;
}

/** read-only scope の connection + token pair を作る（write control の設定が不要で最小）。 */
async function createConnection(targetUserId: string): Promise<ConnectionAuthorization> {
  const code = `code-${crypto.randomUUID()}`;
  const { data: connectionId, error: grantError } = await admin.rpc(
    'create_oauth_authorization_grant_v2',
    {
      p_user_id: targetUserId,
      p_client_id: 'claude-ai',
      p_resource_uri: resource,
      p_scopes: ['read:entries'],
      p_code_hash: hashToken(code),
      p_redirect_uri: redirectUri,
      p_code_challenge: challenge,
      p_write_enabled: false,
    },
  );
  if (grantError || !connectionId) throw grantError ?? new Error('Connection was not created');

  const refreshToken = `dop_rt_${crypto.randomUUID()}`;
  const { error: exchangeError } = await admin.rpc('exchange_oauth_authorization_code_v2', {
    p_code_hash: hashToken(code),
    p_client_id: 'claude-ai',
    p_redirect_uri: redirectUri,
    p_resource_uri: resource,
    p_code_challenge: challenge,
    p_refresh_hash: hashToken(refreshToken),
    p_access_hash: hashToken(`dop_at_${crypto.randomUUID()}`),
  });
  if (exchangeError) throw exchangeError;

  return { connectionId, refreshToken };
}

function rotateRefreshToken(refreshToken: string) {
  return admin
    .rpc('rotate_oauth_refresh_token_v2', {
      p_refresh_hash: hashToken(refreshToken),
      p_client_id: 'claude-ai',
      p_resource_uri: resource,
      p_new_refresh_hash: hashToken(`dop_rt_${crypto.randomUUID()}`),
      p_new_access_hash: hashToken(`dop_at_${crypto.randomUUID()}`),
    })
    .single();
}

describe.skipIf(!RUN_LOCAL)('MCP connections revoke integration', () => {
  beforeAll(async () => {
    const { error: ownerCreateError } = await admin.auth.admin.createUser({
      id: ownerId,
      email: ownerEmail,
      password,
      email_confirm: true,
    });
    if (ownerCreateError) throw ownerCreateError;

    const { error: otherCreateError } = await admin.auth.admin.createUser({
      id: otherId,
      email: otherEmail,
      password,
      email_confirm: true,
    });
    if (otherCreateError) throw otherCreateError;

    const { error: ownerSignInError } = await ownerClient.auth.signInWithPassword({
      email: ownerEmail,
      password,
    });
    if (ownerSignInError) throw ownerSignInError;

    const { error: otherSignInError } = await otherClient.auth.signInWithPassword({
      email: otherEmail,
      password,
    });
    if (otherSignInError) throw otherSignInError;
  });

  afterEach(async () => {
    await admin.from('oauth_connections').delete().eq('user_id', ownerId);
    await admin.from('oauth_connections').delete().eq('user_id', otherId);
  });

  afterAll(async () => {
    await ownerClient.auth.signOut();
    await otherClient.auth.signOut();
    await admin.auth.admin.deleteUser(ownerId);
    await admin.auth.admin.deleteUser(otherId);
  });

  it('revokes the caller own connection and cascades to every token in it', async () => {
    const authorization = await createConnection(ownerId);

    const { data: success, error } = await ownerClient.rpc('revoke_oauth_connection', {
      p_connection_id: authorization.connectionId,
    });
    expect(error).toBeNull();
    expect(success).toBe(true);

    const { data: connection, error: connectionError } = await admin
      .from('oauth_connections')
      .select('revoked_at, revoked_reason')
      .eq('id', authorization.connectionId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection?.revoked_at).not.toBeNull();
    expect(connection?.revoked_reason).toBe('user_revoked');

    const { data: tokens, error: tokensError } = await admin
      .from('oauth_tokens')
      .select('token_type, revoked_at')
      .eq('connection_id', authorization.connectionId);
    expect(tokensError).toBeNull();
    // exchange が発行した refresh + access の 2 本が両方 revoke されていること。
    expect(tokens).toHaveLength(2);
    expect(tokens?.every((token) => token.revoked_at !== null)).toBe(true);
  });

  // 下の revoke 後 rotation test の対照。これが無いと、rotation が revoke 以外の理由
  // （client_id / resource / hash の不一致、helper の bug）で常に失敗していても
  // `invalid_grant` の assertion が通ってしまい、test が誤った理由で pass する。
  it('rotates the refresh token while the connection is still active', async () => {
    const authorization = await createConnection(ownerId);

    const { data: rotation, error: rotationError } = await rotateRefreshToken(
      authorization.refreshToken,
    );
    expect(rotationError).toBeNull();
    expect(rotation?.status).toBe('issued');
    expect(rotation?.refresh_id).not.toBeNull();
    expect(rotation?.access_id).not.toBeNull();
  });

  it('rejects refresh token rotation for a revoked connection so the token family cannot revive', async () => {
    const authorization = await createConnection(ownerId);

    const { error: revokeError, data: revoked } = await ownerClient.rpc('revoke_oauth_connection', {
      p_connection_id: authorization.connectionId,
    });
    expect(revokeError).toBeNull();
    expect(revoked).toBe(true);

    const { data: rotation, error: rotationError } = await rotateRefreshToken(
      authorization.refreshToken,
    );
    expect(rotationError).toBeNull();
    expect(rotation?.status).toBe('invalid_grant');
    expect(rotation?.refresh_id).toBeNull();
    expect(rotation?.access_id).toBeNull();

    // rotation が新しい token pair を発行していないこと（family が生き返っていない）。
    const { data: tokens, error: tokensError } = await admin
      .from('oauth_tokens')
      .select('id')
      .eq('connection_id', authorization.connectionId);
    expect(tokensError).toBeNull();
    expect(tokens).toHaveLength(2);
  });

  it('returns false for another user connection and leaves it untouched', async () => {
    const authorization = await createConnection(otherId);

    const { data: success, error } = await ownerClient.rpc('revoke_oauth_connection', {
      p_connection_id: authorization.connectionId,
    });
    expect(error).toBeNull();
    expect(success).toBe(false);

    const { data: connection, error: connectionError } = await admin
      .from('oauth_connections')
      .select('revoked_at, revoked_reason')
      .eq('id', authorization.connectionId)
      .single();
    expect(connectionError).toBeNull();
    expect(connection?.revoked_at).toBeNull();
    expect(connection?.revoked_reason).toBeNull();

    const { data: tokens, error: tokensError } = await admin
      .from('oauth_tokens')
      .select('revoked_at')
      .eq('connection_id', authorization.connectionId);
    expect(tokensError).toBeNull();
    expect(tokens?.every((token) => token.revoked_at === null)).toBe(true);
  });

  it('exposes oauth_connections rows only to their own owner via RLS', async () => {
    const ownerAuthorization = await createConnection(ownerId);
    const otherAuthorization = await createConnection(otherId);

    const { data: ownerRows, error: ownerError } = await ownerClient
      .from('oauth_connections')
      .select('id, user_id');
    expect(ownerError).toBeNull();
    const ownerVisibleIds = (ownerRows ?? []).map((row) => row.id);
    expect(ownerVisibleIds).toContain(ownerAuthorization.connectionId);
    expect(ownerVisibleIds).not.toContain(otherAuthorization.connectionId);
    expect((ownerRows ?? []).every((row) => row.user_id === ownerId)).toBe(true);

    const { data: singleRowAttempt, error: crossReadError } = await otherClient
      .from('oauth_connections')
      .select('id')
      .eq('id', ownerAuthorization.connectionId)
      .maybeSingle();
    expect(crossReadError).toBeNull();
    expect(singleRowAttempt).toBeNull();
  });
});
