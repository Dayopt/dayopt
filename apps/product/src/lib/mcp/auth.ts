import { resolveBillingAccess } from '@dayopt/billing';
import 'server-only';

import { env } from '@/env';

import { isBillingEnforced } from '@/lib/billing/enforcement';
import { databaseTables } from '@/lib/database';
import { logger } from '@/lib/logger';
import {
  OAuthServerError,
  hashToken,
  isRuntimeClientWriteEnabled,
  isSupportedScope,
  isWriteEnabledByMutationControl,
  isWriteScope,
  resolveClient,
  resolveRequestedResource,
  type CanonicalResourceUri,
  type OAuthClientId,
  type SupportedScope,
} from '@/lib/oauth-server';
import {
  assertDatabaseOAuthIdentity,
  resolveDatabaseOAuthProjectRef,
} from '@/lib/oauth-server/database-identity';
import { getOAuthEnvironmentConfig } from '@/lib/oauth-server/identity-env';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

import { createMcpAccessDbClient } from './access-db';

interface VerifiedAccessToken {
  tokenId: string;
  connectionId: string;
  userId: string;
  clientId: OAuthClientId;
  scopes: SupportedScope[];
  /**
   * capability map の `mcp_api` を通過したか。`BILLING_ENFORCED` が未設定（既定）の
   * 間は他の gate と同じく常に true。
   */
  proEntitled: boolean;
  resourceUri: CanonicalResourceUri;
  /** Unix epoch seconds, matching MCP AuthInfo. */
  expiresAt: number;
}

/**
 * Verifies the opaque access token and its current connection authorization.
 * Connection state is read on every request so revoke, reauthorization expiry,
 * scope removal, and the closed-beta client gate take effect without waiting
 * for the five-minute access token to expire.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  const tokenHash = hashToken(token);
  const db = createMcpAccessDbClient();

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
    throwDatabaseVerificationError(error, 'verify_mcp_environment_identity');
  }

  const { data: row, error } = await db
    .from(databaseTables.oauthTokens)
    .select(
      'id, connection_id, user_id, token_type, client_id, scopes, resource_uri, expires_at, revoked_at',
    )
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    throwDatabaseVerificationError(error, 'verify_access_token');
  }
  if (!row || row.token_type !== 'access' || row.revoked_at) {
    throw new OAuthServerError('invalid_token', 'Access token is invalid', 401);
  }

  const expiresAtMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new OAuthServerError('invalid_token', 'Access token expired', 401);
  }

  const client = resolveClient(row.client_id);
  const tokenResource = row.resource_uri ? resolveRequestedResource(row.resource_uri) : null;
  const tokenScopes = parseStoredScopes(row.scopes);
  if (!client || !row.connection_id || !row.resource_uri || !tokenResource || !tokenScopes) {
    throw new OAuthServerError('invalid_token', 'Access token binding is invalid', 401);
  }

  const { data: connection, error: connectionError } = await db
    .from(databaseTables.oauthConnections)
    .select(
      'id, user_id, client_id, resource_uri, scopes, write_enabled_at, revoked_at, reauth_required_at',
    )
    .eq('id', row.connection_id)
    .eq('user_id', row.user_id)
    .eq('client_id', row.client_id)
    .eq('resource_uri', row.resource_uri)
    .maybeSingle();

  if (connectionError) {
    throwDatabaseVerificationError(connectionError, 'verify_oauth_connection');
  }

  const connectionResource = connection ? resolveRequestedResource(connection.resource_uri) : null;
  const connectionScopes = connection ? parseStoredScopes(connection.scopes) : null;
  const reauthRequiredAt = connection
    ? new Date(connection.reauth_required_at).getTime()
    : Number.NaN;
  if (
    !connection ||
    connection.revoked_at ||
    !connectionResource ||
    connectionResource !== tokenResource ||
    !connectionScopes ||
    !Number.isFinite(reauthRequiredAt) ||
    reauthRequiredAt <= Date.now()
  ) {
    throw new OAuthServerError('invalid_token', 'OAuth connection is no longer authorized', 401);
  }

  const connectionFilteredScopes = tokenScopes
    .filter((scope) => connectionScopes.includes(scope))
    .filter(
      (scope) =>
        !isWriteScope(scope) ||
        (isRuntimeClientWriteEnabled(client.id) && Boolean(connection.write_enabled_at)),
    );
  const durablyFilteredScopes = await applyDurableWriteGate(
    db,
    client.id,
    connectionFilteredScopes,
  );

  if (durablyFilteredScopes.length === 0) {
    throw new OAuthServerError('invalid_token', 'OAuth connection has no active scopes', 401);
  }

  const proEntitled = await checkMcpEntitlement(db, row.user_id);

  // 拒否されたFree accessをSettingsの「最終利用」として記録しない。
  if (proEntitled) updateUsageTimestamps(db, row.id, connection.id);

  return {
    tokenId: row.id,
    connectionId: connection.id,
    userId: row.user_id,
    clientId: client.id,
    scopes: durablyFilteredScopes,
    proEntitled,
    resourceUri: tokenResource,
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

async function applyDurableWriteGate(
  db: ReturnType<typeof createMcpAccessDbClient>,
  clientId: OAuthClientId,
  scopes: SupportedScope[],
): Promise<SupportedScope[]> {
  if (!scopes.some(isWriteScope)) return scopes;

  const { data: control, error } = await db
    .from(databaseTables.mcpMutationControl)
    .select('writes_enabled, enabled_client_ids')
    .eq('singleton_key', true)
    .maybeSingle();

  if (error) {
    throwDatabaseVerificationError(error, 'verify_mcp_mutation_control');
  }
  if (!control) {
    throwDatabaseVerificationError(
      new Error('MCP mutation control row is missing'),
      'verify_mcp_mutation_control',
    );
  }

  return isWriteEnabledByMutationControl(control, clientId)
    ? scopes
    : scopes.filter((scope) => !isWriteScope(scope));
}

/**
 * MCP route の entitlement 判定（gate の型は `route`）。
 *
 * 他の gate（`entitledProcedure` / `checkEntitlementForUser`）と同じく
 * `BILLING_ENFORCED` に従う。無効（既定）なら `profiles` を読まずに true。
 */
async function checkMcpEntitlement(
  db: ReturnType<typeof createMcpAccessDbClient>,
  userId: string,
): Promise<boolean> {
  if (!isBillingEnforced()) return true;

  const { data: profile, error } = await db
    .from(databaseTables.profiles)
    .select('subscription_status, app_trial_started_at, app_trial_ends_at, app_trial_consumed_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throwDatabaseVerificationError(error, 'verify_mcp_pro_entitlement');
  }
  if (!profile) {
    throwDatabaseVerificationError(
      new Error('MCP entitlement profile is missing'),
      'verify_mcp_pro_entitlement',
    );
  }

  return resolveBillingAccess(profile, Date.now(), true).canUseProduct;
}

function parseStoredScopes(scopes: string[]): SupportedScope[] | null {
  if (!scopes.every(isSupportedScope)) return null;
  const parsed = [...new Set(scopes)];
  if (parsed.some(isWriteScope) && !parsed.includes('read:entries')) return null;
  return parsed;
}

function throwDatabaseVerificationError(error: unknown, operation: string): never {
  const original = captureUnexpectedDatabaseError(error, {
    feature: 'mcp',
    operation,
  });
  throw new OAuthServerError('server_error', 'Access token verification failed', 503, {
    cause: original,
  });
}

function updateUsageTimestamps(
  db: ReturnType<typeof createMcpAccessDbClient>,
  tokenId: string,
  connectionId: string,
): void {
  const usedAt = new Date().toISOString();
  void Promise.all([
    db.from(databaseTables.oauthTokens).update({ last_used_at: usedAt }).eq('id', tokenId),
    db
      .from(databaseTables.oauthConnections)
      .update({ last_used_at: usedAt })
      .eq('id', connectionId),
  ]).then((results) => {
    for (const result of results) {
      if (!result.error) continue;
      captureUnexpectedDatabaseError(result.error, {
        feature: 'mcp',
        operation: 'update_oauth_usage_timestamp',
      });
      logger.warn('MCP OAuth usage timestamp update failed');
    }
  });
}

export function extractBearerToken(authHeader: string | null): string {
  if (!authHeader) {
    throw new OAuthServerError('invalid_request', 'Missing Authorization header', 401);
  }
  if (!/^Bearer(?:\s|$)/i.test(authHeader)) {
    throw new OAuthServerError('invalid_request', 'Bearer authorization is required', 401);
  }
  const match = authHeader.match(/^Bearer +([A-Za-z0-9._~+/-]+=*)$/i);
  if (!match || !match[1]) {
    throw new OAuthServerError(
      'invalid_request',
      'Authorization header must be "Bearer <token>"',
      400,
    );
  }
  return match[1];
}
