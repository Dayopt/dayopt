import { createDayoptUrl, dayoptUrls } from '@dayopt/config';

import {
  normalizeHttpsOrigin,
  type CanonicalAuthorizationServerUri,
  type CanonicalResourceUri,
} from './origin';

/**
 * Dayopt が所有する OAuth identity は production と ephemeral preview の 2 つだけ。
 * Persistent Staging は作らない決定に合わせ、DB 側の
 * `mcp_environment_identity_tuple_check` も production / preview のみを許す。
 */
export type McpOAuthEnvironment = 'production' | 'preview';

export interface OAuthEnvironmentConfig {
  environment: McpOAuthEnvironment;
  surfacesEnabled: boolean;
  authorizationServerUri: CanonicalAuthorizationServerUri;
  authorizationServerHost: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resourceUri: CanonicalResourceUri;
  resourceHost: string;
  protectedResourceMetadataUri: string;
}

interface OAuthEnvironmentInput {
  mcpOAuthEnvironment?: string | undefined;
  authorizationServerUri?: string | undefined;
  resourceUri?: string | undefined;
  vercelEnvironment?: string | undefined;
  vercelTargetEnvironment?: string | undefined;
  vercelBranchUrl?: string | undefined;
  vercelGitCommitRef?: string | undefined;
  mcpOAuthPreviewBranch?: string | undefined;
}

/** Normalize deployment env at both proxy and handler boundaries before applying identity policy. */
export function resolveOAuthEnvironmentFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): OAuthEnvironmentConfig {
  const read = (key: string): string | undefined => environment[key]?.trim() || undefined;
  return resolveOAuthEnvironmentConfig({
    mcpOAuthEnvironment: read('MCP_OAUTH_ENVIRONMENT'),
    authorizationServerUri: read('OAUTH_AUTHORIZATION_SERVER_URI'),
    resourceUri: read('MCP_CANONICAL_RESOURCE_URI'),
    vercelEnvironment: read('VERCEL_ENV'),
    vercelTargetEnvironment: read('VERCEL_TARGET_ENV'),
    vercelBranchUrl: read('VERCEL_BRANCH_URL'),
    vercelGitCommitRef: read('VERCEL_GIT_COMMIT_REF'),
    mcpOAuthPreviewBranch: read('MCP_OAUTH_PREVIEW_BRANCH'),
  });
}

const AUTHORIZATION_SERVER_PATHS = new Set([
  '/oauth/authorize',
  '/oauth/consent',
  '/oauth/token',
  '/api/oauth/token',
  '/.well-known/oauth-authorization-server',
]);

const PROTECTED_RESOURCE_PATHS = new Set([
  '/mcp',
  '/api/mcp',
  '/.well-known/oauth-protected-resource',
]);

const KNOWN_RESOURCE_HOSTS = new Set([new URL(dayoptUrls.mcp).hostname]);

const KNOWN_AUTHORIZATION_SERVER_HOSTS = new Set([new URL(dayoptUrls.product).hostname]);

const EXPECTED_IDENTITIES = {
  production: {
    authorizationServerUri: dayoptUrls.product,
    resourceUri: dayoptUrls.mcp,
  },
} as const;

/**
 * Resolve the one OAuth identity owned by this deployment.
 *
 * Production keeps the established origin defaults. Preview has no fallback:
 * marker, issuer, resource, and Vercel Custom Environment must agree.
 */
export function resolveOAuthEnvironmentConfig(
  input: OAuthEnvironmentInput,
): OAuthEnvironmentConfig {
  const environment = resolveEnvironment(input.mcpOAuthEnvironment);
  const expected =
    environment === 'preview'
      ? resolvePreviewIdentity(input.vercelBranchUrl)
      : EXPECTED_IDENTITIES[environment];
  const authorizationServerUri = normalizeAuthorizationServerUri(
    input.authorizationServerUri ??
      (environment === 'production' ? expected.authorizationServerUri : ''),
  );
  const resourceUri = normalizeResourceUri(
    input.resourceUri ?? (environment === 'production' ? expected.resourceUri : ''),
  );

  if (authorizationServerUri !== expected.authorizationServerUri) {
    throw new Error(`OAUTH_AUTHORIZATION_SERVER_URI must match the ${environment} OAuth identity`);
  }
  if (resourceUri !== expected.resourceUri) {
    throw new Error(`MCP_CANONICAL_RESOURCE_URI must match the ${environment} OAuth identity`);
  }

  assertVercelEnvironmentBinding(input, environment);

  return {
    environment,
    surfacesEnabled: isOAuthSurfaceEnabled(input, environment),
    authorizationServerUri,
    authorizationServerHost: new URL(authorizationServerUri).hostname,
    authorizationEndpoint: createDayoptUrl(authorizationServerUri, '/oauth/authorize'),
    tokenEndpoint: createDayoptUrl(authorizationServerUri, '/oauth/token'),
    resourceUri,
    resourceHost: new URL(resourceUri).hostname,
    protectedResourceMetadataUri: createDayoptUrl(
      resourceUri,
      '/.well-known/oauth-protected-resource',
    ),
  };
}

export function isOAuthSurfacePath(pathname: string): boolean {
  const normalizedPathname = normalizeOAuthSurfacePath(pathname);
  return (
    AUTHORIZATION_SERVER_PATHS.has(normalizedPathname) ||
    PROTECTED_RESOURCE_PATHS.has(normalizedPathname)
  );
}

export function isOAuthRequestHostAllowed(input: {
  identity: OAuthEnvironmentConfig;
  hostname: string;
  pathname: string;
  allowLocalDevelopment: boolean;
}): boolean {
  const { hostname, identity } = input;
  const pathname = normalizeOAuthSurfacePath(input.pathname);
  if (input.allowLocalDevelopment && isLocalHostname(hostname)) return true;

  if (
    !identity.surfacesEnabled &&
    (KNOWN_AUTHORIZATION_SERVER_HOSTS.has(hostname) ||
      KNOWN_RESOURCE_HOSTS.has(hostname) ||
      isOAuthSurfacePath(pathname))
  ) {
    return false;
  }

  const ownsAuthorizationSurface = hostname === identity.authorizationServerHost;
  const ownsResourceSurface = hostname === identity.resourceHost;

  if (KNOWN_RESOURCE_HOSTS.has(hostname) && hostname !== identity.resourceHost) return false;
  if (ownsAuthorizationSurface && ownsResourceSurface) {
    return true;
  }
  if (ownsResourceSurface) {
    return pathname === '/' || PROTECTED_RESOURCE_PATHS.has(pathname);
  }
  if (
    KNOWN_AUTHORIZATION_SERVER_HOSTS.has(hostname) &&
    hostname !== identity.authorizationServerHost
  ) {
    return false;
  }
  if (PROTECTED_RESOURCE_PATHS.has(pathname)) return false;
  if (AUTHORIZATION_SERVER_PATHS.has(pathname)) {
    return ownsAuthorizationSurface;
  }

  return true;
}

function resolveEnvironment(value: string | undefined): McpOAuthEnvironment {
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'preview') return 'preview';
  throw new Error('MCP_OAUTH_ENVIRONMENT must be production or preview');
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function normalizeOAuthSurfacePath(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/u, '');
}

function normalizeAuthorizationServerUri(value: string): CanonicalAuthorizationServerUri | null {
  return normalizeHttpsOrigin(value) as CanonicalAuthorizationServerUri | null;
}

function normalizeResourceUri(value: string): CanonicalResourceUri | null {
  return normalizeHttpsOrigin(value) as CanonicalResourceUri | null;
}

function assertVercelEnvironmentBinding(
  input: OAuthEnvironmentInput,
  environment: McpOAuthEnvironment,
): void {
  const targetsPreview = input.vercelTargetEnvironment === 'preview';

  if (input.vercelEnvironment === 'production' && environment !== 'production') {
    throw new Error('A Vercel Production deployment must use the production OAuth identity');
  }
  if (input.mcpOAuthPreviewBranch && environment !== 'preview') {
    throw new Error('MCP_OAUTH_PREVIEW_BRANCH requires MCP_OAUTH_ENVIRONMENT=preview');
  }
  if (environment === 'preview') {
    if (input.vercelEnvironment !== 'preview' || !targetsPreview) {
      throw new Error(
        'MCP preview identity requires VERCEL_ENV=preview and VERCEL_TARGET_ENV=preview',
      );
    }
    if (
      !input.mcpOAuthPreviewBranch ||
      !input.vercelGitCommitRef ||
      input.vercelGitCommitRef !== input.mcpOAuthPreviewBranch
    ) {
      throw new Error('MCP preview identity requires the exact configured Vercel branch');
    }
  }
}

function isOAuthSurfaceEnabled(
  input: OAuthEnvironmentInput,
  environment: McpOAuthEnvironment,
): boolean {
  if (!input.vercelEnvironment) return true;
  if (environment === 'preview') {
    return (
      input.vercelEnvironment === 'preview' &&
      input.vercelTargetEnvironment === 'preview' &&
      input.vercelGitCommitRef === input.mcpOAuthPreviewBranch
    );
  }
  return input.vercelEnvironment === 'production';
}

function resolvePreviewIdentity(vercelBranchUrl: string | undefined): {
  authorizationServerUri: CanonicalAuthorizationServerUri;
  resourceUri: CanonicalResourceUri;
} {
  if (!vercelBranchUrl || vercelBranchUrl !== vercelBranchUrl.trim()) {
    throw new Error('MCP preview identity requires VERCEL_BRANCH_URL');
  }
  if (
    !/^product-git-[a-z0-9-]+-dayopt\.vercel\.app$/u.test(vercelBranchUrl) ||
    vercelBranchUrl.includes('..')
  ) {
    throw new Error('MCP preview identity requires the stable Product branch alias');
  }

  const origin = normalizeHttpsOrigin(`https://${vercelBranchUrl}`);
  if (!origin) {
    throw new Error('MCP preview identity requires a valid stable Product branch alias');
  }

  return {
    authorizationServerUri: origin as CanonicalAuthorizationServerUri,
    resourceUri: origin as CanonicalResourceUri,
  };
}
