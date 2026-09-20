'use server';

import { redirect } from 'next/navigation';

import { logger } from '@/lib/logger';
import {
  assertTokenIssuanceDatabaseIdentity,
  createOAuthDbClient,
  generateAuthorizationCode,
  hasWriteScope,
  isConsentWriteEnabled,
  resolveGrantableScopes,
  validateAuthorizeInput,
} from '@/lib/oauth-server';
import { assertOAuthAuthorizationRequestHost } from '@/lib/oauth-server/authorization-request-host';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedDatabaseError, observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';

/**
 * Consent UI から呼ばれる Server Action。
 *
 * Approve: authorization_code を発行 → DB に hash を保存 → redirect_uri?code=...&state=...
 * Deny:    redirect_uri?error=access_denied&state=...
 *
 * Defense in depth: hidden field の改ざんに備え、validateAuthorizeInput を再実行する。
 */
export async function processConsent(formData: FormData) {
  await assertOAuthAuthorizationRequestHost();

  const get = (key: string): string | undefined => {
    const v = formData.get(key);
    return typeof v === 'string' ? v : undefined;
  };

  const validation = validateAuthorizeInput({
    response_type: 'code',
    client_id: get('client_id'),
    redirect_uri: get('redirect_uri'),
    code_challenge: get('code_challenge'),
    code_challenge_method: 'S256',
    scope: get('scope'),
    state: get('state'),
    resource: get('resource'),
  });

  if (!validation.ok) {
    logger.warn(
      { error: validation.error },
      '[oauth] consent action received invalid params (tampered hidden fields?)',
    );
    redirect('/oauth/authorize');
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await observeAuthOperation('oauth_consent_action_get_user', () => supabase.auth.getUser());
  if (authError || !user) {
    redirect('/auth/login');
  }

  const decision = get('decision');
  const redirectUrl = new URL(validation.redirectUri);
  if (validation.state) redirectUrl.searchParams.set('state', validation.state);

  if (decision !== 'approve') {
    redirectUrl.searchParams.set('error', 'access_denied');
    redirect(redirectUrl.toString());
  }

  if (await isWriteFenceEnabled(supabase)) {
    logger.warn('[oauth] consent grant blocked by write fence');
    redirectUrl.searchParams.set('error', 'temporarily_unavailable');
    redirect(redirectUrl.toString());
  }

  const dbClient = createOAuthDbClient();

  // Preview branch 再作成などで DB identity が deploy とずれている場合、
  // grant を書き込んでも token endpoint 側の同じ検証で必ず拒否される。
  // 不一致 DB への service-role 書き込み自体を grant RPC の前で止める。
  // Sentry capture は assertTokenIssuanceDatabaseIdentity 内で済んでいる。
  try {
    await assertTokenIssuanceDatabaseIdentity(dbClient);
  } catch {
    logger.error('[oauth] consent grant blocked by database identity mismatch');
    redirectUrl.searchParams.set('error', 'server_error');
    redirect(redirectUrl.toString());
  }

  // hidden field は改ざんされうるので、付与する scope をここで再計算する。
  // write gate（env allowlist AND `mcp_mutation_control`）が閉じている client では
  // write scope を落とし、read-only の grant として成立させる。grant RPC は
  // write 要求 + gate 閉を例外で拒否する（42501 / DM003）ため、ここで落とさないと
  // read 目的の接続まで `server_error` になる。
  const grantableScopes = resolveGrantableScopes(
    validation.scopes,
    await isConsentWriteEnabled(dbClient, validation.client.id),
  );

  if (grantableScopes.length === 0) {
    logger.warn('[oauth] consent grant had no grantable scopes after the write gate');
    redirectUrl.searchParams.set('error', 'invalid_scope');
    redirect(redirectUrl.toString());
  }

  const { code, hash } = generateAuthorizationCode();
  const { error: insertError } = await dbClient.rpc('create_oauth_authorization_grant_v2', {
    p_code_hash: hash,
    p_user_id: user.id,
    p_client_id: validation.client.id,
    p_resource_uri: validation.resourceUri,
    p_redirect_uri: validation.redirectUri,
    p_code_challenge: validation.codeChallenge,
    p_scopes: grantableScopes,
    p_write_enabled: hasWriteScope(grantableScopes),
  });

  if (insertError) {
    logger.error('[oauth] failed to persist authorization code');
    captureUnexpectedDatabaseError(insertError, {
      feature: 'oauth',
      operation: 'persist_authorization_code',
      route: '/oauth/consent',
    });
    redirectUrl.searchParams.set('error', 'server_error');
    redirect(redirectUrl.toString());
  }

  redirectUrl.searchParams.set('code', code);
  redirect(redirectUrl.toString());
}
