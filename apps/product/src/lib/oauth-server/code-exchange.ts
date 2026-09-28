import 'server-only';

import { env } from '@/env';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import type { OAuthClientId } from './clients';
import { assertDatabaseOAuthIdentity, resolveDatabaseOAuthProjectRef } from './database-identity';
import { createOAuthDbClient } from './db';
import { OAuthServerError } from './errors';
import { getOAuthEnvironmentConfig } from './identity-env';
import type { CanonicalResourceUri } from './resource';
import type { SupportedScope } from './scopes';
import {
  derivePkceS256Challenge,
  generateOpaqueToken,
  hashToken,
  isValidPkceVerifier,
} from './tokens';

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface ExchangeAuthorizationCodeInput {
  code: string;
  /** The token route has already resolved this against the static client allowlist. */
  client_id: OAuthClientId;
  redirect_uri: string;
  code_verifier: string;
  resource_uri: CanonicalResourceUri;
}

/**
 * Atomically consumes an authorization code and issues its connection-bound
 * access/refresh pair. PKCE syntax is rejected before touching the code; the
 * derived challenge is compared inside the same database transaction that
 * consumes it.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<TokenResponse> {
  if (!isValidPkceVerifier(input.code_verifier)) {
    throw new OAuthServerError('invalid_grant', 'PKCE verification failed');
  }

  const access = generateOpaqueToken('access');
  const refresh = generateOpaqueToken('refresh');
  const db = createOAuthDbClient();
  await assertTokenIssuanceDatabaseIdentity(db);
  const { data: rows, error } = await db.rpc('exchange_oauth_authorization_code_v2', {
    p_code_hash: hashToken(input.code),
    p_client_id: input.client_id,
    p_redirect_uri: input.redirect_uri,
    p_resource_uri: input.resource_uri,
    p_code_challenge: derivePkceS256Challenge(input.code_verifier),
    p_refresh_hash: refresh.hash,
    p_access_hash: access.hash,
  });

  if (error) {
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'oauth',
      operation: 'exchange_authorization_code',
    });
    throw new OAuthServerError('server_error', 'Authorization code exchange failed', 500, {
      cause: original,
    });
  }
  if (!rows || rows.length !== 1) {
    throw new OAuthServerError('invalid_grant', 'Invalid or expired authorization code');
  }

  return buildTokenResponse({
    accessToken: access.token,
    refreshToken: refresh.token,
    accessExpiresAt: rows[0]!.access_expires_at,
    scopes: rows[0]!.scopes as SupportedScope[],
  });
}

interface RefreshAccessTokenInput {
  refresh_token: string;
  /** The token route has already resolved this against the static client allowlist. */
  client_id: OAuthClientId;
  resource_uri: CanonicalResourceUri;
}

/**
 * Rotates a refresh token and issues a new pair in one database transaction.
 * A likely parallel retry inside the DB grace window returns invalid_grant but
 * does not revoke the winning family. Reuse outside that window revokes it.
 */
export async function refreshAccessToken(input: RefreshAccessTokenInput): Promise<TokenResponse> {
  const access = generateOpaqueToken('access');
  const refresh = generateOpaqueToken('refresh');
  const db = createOAuthDbClient();
  await assertTokenIssuanceDatabaseIdentity(db);
  const { data: rows, error } = await db.rpc('rotate_oauth_refresh_token_v2', {
    p_refresh_hash: hashToken(input.refresh_token),
    p_client_id: input.client_id,
    p_resource_uri: input.resource_uri,
    p_new_refresh_hash: refresh.hash,
    p_new_access_hash: access.hash,
  });

  if (error) {
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'oauth',
      operation: 'rotate_refresh_token',
    });
    throw new OAuthServerError('server_error', 'Refresh token rotation failed', 500, {
      cause: original,
    });
  }

  const row = rows?.[0];
  if (!row || row.status !== 'issued' || !row.access_expires_at || !row.scopes) {
    throw new OAuthServerError('invalid_grant', 'Invalid or expired refresh token');
  }

  return buildTokenResponse({
    accessToken: access.token,
    refreshToken: refresh.token,
    accessExpiresAt: row.access_expires_at,
    scopes: row.scopes as SupportedScope[],
  });
}

/**
 * Fail closed before any service-role token issuance write. A Preview Supabase
 * branch can be recreated under the same Vercel resource URI with a different
 * project ref; the grant/exchange/rotation RPCs only match resource_uri, so
 * without this gate the consent action and token endpoint would write into a
 * mismatched database and mint grants/tokens the MCP resource side immediately
 * rejects (mcp/auth.ts runs the same assertion on verification).
 */
export async function assertTokenIssuanceDatabaseIdentity(
  db: ReturnType<typeof createOAuthDbClient>,
): Promise<void> {
  try {
    const expectedIdentity = getOAuthEnvironmentConfig();
    const expectedSupabaseProjectRef = resolveDatabaseOAuthProjectRef({
      environment: expectedIdentity.environment,
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    });
    await assertDatabaseOAuthIdentity(
      expectedIdentity,
      () => db.rpc('get_mcp_environment_identity_v1'),
      expectedSupabaseProjectRef,
    );
  } catch (error) {
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'oauth',
      operation: 'verify_token_issuance_identity',
    });
    throw new OAuthServerError('server_error', 'OAuth token issuance is unavailable', 503, {
      cause: original,
    });
  }
}

interface BuildTokenResponseInput {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  scopes: SupportedScope[];
}

function buildTokenResponse(input: BuildTokenResponseInput): TokenResponse {
  const expiresIn = Math.max(
    0,
    Math.floor((new Date(input.accessExpiresAt).getTime() - Date.now()) / 1000),
  );

  return {
    access_token: input.accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: input.refreshToken,
    scope: input.scopes.join(' '),
  };
}
