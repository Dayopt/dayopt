import 'server-only';

import type { OAuthEnvironmentConfig } from './identity';

interface DatabaseOAuthIdentity {
  environment: string;
  authorization_server_uri: string;
  resource_uri: string;
  supabase_project_ref: string | null;
  provisioned_at: string;
}

interface DatabaseIdentityQueryResult {
  data: DatabaseOAuthIdentity[] | null;
  error: unknown;
}

type DatabaseIdentityQuery = () => PromiseLike<DatabaseIdentityQueryResult>;

export class DatabaseOAuthIdentityError extends Error {
  constructor(cause?: unknown) {
    super('Database OAuth identity is unavailable', cause === undefined ? undefined : { cause });
    this.name = 'DatabaseOAuthIdentityError';
  }
}

export function matchesDatabaseOAuthIdentity(
  row: DatabaseOAuthIdentity,
  expected: OAuthEnvironmentConfig,
  expectedSupabaseProjectRef: string | null = null,
): boolean {
  return (
    row.environment === expected.environment &&
    row.authorization_server_uri === expected.authorizationServerUri &&
    row.resource_uri === expected.resourceUri &&
    row.supabase_project_ref === expectedSupabaseProjectRef
  );
}

/**
 * Require the deployment identity and database identity to be the same exact
 * tuple. Errors deliberately omit either tuple so readiness logs cannot expose
 * configuration or credentials.
 */
export async function assertDatabaseOAuthIdentity(
  expected: OAuthEnvironmentConfig,
  query: DatabaseIdentityQuery,
  expectedSupabaseProjectRef: string | null = null,
): Promise<void> {
  let result: DatabaseIdentityQueryResult;

  try {
    result = await query();
  } catch (error) {
    throw new DatabaseOAuthIdentityError(error);
  }

  if (
    result.error ||
    result.data?.length !== 1 ||
    !matchesDatabaseOAuthIdentity(result.data[0]!, expected, expectedSupabaseProjectRef)
  ) {
    throw new DatabaseOAuthIdentityError(result.error ?? undefined);
  }
}

export function resolveDatabaseOAuthProjectRef(input: {
  environment: OAuthEnvironmentConfig['environment'];
  supabaseUrl: string | undefined;
}): string | null {
  if (input.environment !== 'preview') return null;

  try {
    if (!input.supabaseUrl) throw new Error();
    const url = new URL(input.supabaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }

    const hostMatch = /^([a-z]{20})[.]supabase[.]co$/u.exec(url.hostname);
    if (!hostMatch?.[1]) throw new Error();

    // Opaque API keys carry no project claims. The URL identifies the expected
    // project; the authenticated identity RPC above must independently return
    // the same project ref. A mismatched key fails authentication at that URL.
    return hostMatch[1];
  } catch {
    throw new DatabaseOAuthIdentityError();
  }
}
