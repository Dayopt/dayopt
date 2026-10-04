/**
 * Resolve the Product application's identity independently from its database.
 * A Vercel Preview may intentionally share the persistent nonproduction
 * Supabase project with the fixed Integration app.
 */
type DayoptEnvironment = 'production' | 'preview' | 'integration' | 'development' | 'unknown';

export const PRODUCT_VERCEL_PROJECT_ID = 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa';
export const PRODUCT_INTEGRATION_APP_ORIGIN = 'https://product-git-integration-dayopt.vercel.app';
export const PRODUCT_INTEGRATION_SUPABASE_REF = 'tilwaprottpyhlfoggbb';
export const PRODUCT_PRODUCTION_SUPABASE_REF = 'yvglwblxrnrenfifsnje';

interface DayoptEnvironmentInput {
  dayoptEnvironment?: string | undefined;
  publicDayoptEnvironment?: string | undefined;
  vercelEnvironment?: string | undefined;
  vercelTargetEnvironment?: string | undefined;
  vercelProjectId?: string | undefined;
  vercelGitCommitRef?: string | undefined;
  vercelUrl?: string | undefined;
  vercelBranchUrl?: string | undefined;
  appUrl?: string | undefined;
  supabaseUrl?: string | undefined;
}

export function resolveDayoptEnvironment(input: DayoptEnvironmentInput): DayoptEnvironment {
  const dayoptMarker = normalize(input.dayoptEnvironment);
  const publicMarker = normalize(input.publicDayoptEnvironment);
  if (dayoptMarker && publicMarker && dayoptMarker !== publicMarker) return 'unknown';

  const marker = dayoptMarker ?? publicMarker;
  const vercelEnvironment = normalize(input.vercelEnvironment);
  const vercelTargetEnvironment = normalize(input.vercelTargetEnvironment);
  const vercelProjectId = normalize(input.vercelProjectId);
  const vercelGitCommitRef = normalize(input.vercelGitCommitRef);
  const projectRef = resolveSupabaseProjectRef(input.supabaseUrl);

  if (marker && !isDayoptEnvironment(marker)) return 'unknown';
  if (vercelEnvironment === 'preview' && vercelProjectId !== PRODUCT_VERCEL_PROJECT_ID) {
    return 'unknown';
  }

  if (projectRef === PRODUCT_PRODUCTION_SUPABASE_REF) {
    if (
      vercelEnvironment !== 'production' ||
      (vercelTargetEnvironment && vercelTargetEnvironment !== 'production') ||
      vercelGitCommitRef !== 'main' ||
      (marker && marker !== 'production')
    ) {
      return 'unknown';
    }
    return 'production';
  }

  if (projectRef === PRODUCT_INTEGRATION_SUPABASE_REF) {
    if (vercelEnvironment === 'preview') {
      if (vercelGitCommitRef === 'integration') {
        if (
          dayoptMarker !== 'integration' ||
          publicMarker !== 'integration' ||
          vercelProjectId !== PRODUCT_VERCEL_PROJECT_ID ||
          (vercelTargetEnvironment && vercelTargetEnvironment !== 'preview') ||
          !isExactOrigin(input.appUrl, PRODUCT_INTEGRATION_APP_ORIGIN) ||
          input.vercelBranchUrl !== PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length)
        ) {
          return 'unknown';
        }
        return 'integration';
      }

      if (
        (vercelTargetEnvironment && vercelTargetEnvironment !== 'preview') ||
        (marker && marker !== 'preview') ||
        !isPreviewAppUrlConsistent(input)
      ) {
        return 'unknown';
      }
      return 'preview';
    }

    // Local full-app use of the shared project must be explicit.
    if (!vercelEnvironment && marker === 'development') return 'development';
    if (
      vercelEnvironment === 'development' &&
      marker === 'development' &&
      (!vercelTargetEnvironment || vercelTargetEnvironment === 'development')
    ) {
      return 'development';
    }
    return 'unknown';
  }

  if (vercelEnvironment === 'preview') {
    if (
      vercelGitCommitRef === 'integration' ||
      marker === 'integration' ||
      (vercelTargetEnvironment && vercelTargetEnvironment !== 'preview') ||
      (marker && marker !== 'preview') ||
      !isPreviewAppUrlConsistent(input)
    ) {
      return 'unknown';
    }
    return projectRef ? 'preview' : 'unknown';
  }

  if (vercelEnvironment === 'production') return 'unknown';

  if (vercelEnvironment === 'development') {
    if (marker && marker !== 'development') return 'unknown';
    if (vercelTargetEnvironment && vercelTargetEnvironment !== 'development') return 'unknown';
    return projectRef && marker !== 'development' ? 'unknown' : 'development';
  }

  if (!vercelEnvironment) {
    if (marker === 'production' || marker === 'preview' || marker === 'integration') {
      return 'unknown';
    }
    if (marker === 'development') return 'development';
    // Local Supabase instances have no hosted project ref and remain easy to use.
    // A hosted nonproduction ref should be an explicit local connection.
    return projectRef ? 'unknown' : 'development';
  }

  return 'unknown';
}

export function resolveSupabaseProjectRef(supabaseUrl: string | undefined): string | undefined {
  if (!supabaseUrl) return undefined;

  try {
    const url = new URL(supabaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }

    const match = /^([a-z]{20})[.]supabase[.]co$/u.exec(url.hostname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function isPreviewAppUrlConsistent(input: DayoptEnvironmentInput): boolean {
  const appUrl = normalize(input.appUrl);
  if (!appUrl) return true;

  let origin: string;
  try {
    const url = new URL(appUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    origin = url.origin;
  } catch {
    return false;
  }

  const expectedHosts = [input.vercelUrl, input.vercelBranchUrl].filter((host): host is string =>
    Boolean(host && isProductPreviewHost(host)),
  );
  return expectedHosts.some((host) => origin === `https://${host}`);
}

function isProductPreviewHost(value: string): boolean {
  return /^product-(?:git-)?[a-z0-9-]+-dayopt[.]vercel[.]app$/u.test(value);
}

function isExactOrigin(value: string | undefined, expectedOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === expectedOrigin && value === expectedOrigin;
  } catch {
    return false;
  }
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isDayoptEnvironment(value: string): value is Exclude<DayoptEnvironment, 'unknown'> {
  return (
    value === 'production' ||
    value === 'preview' ||
    value === 'integration' ||
    value === 'development'
  );
}

/** Server deployment identity only; ordinary Preview has no OAuth issuer authority. */
export function isOrdinaryProductPreview(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const read = (key: string) => environment[key]?.trim() || undefined;
  if (
    read('VERCEL_ENV') !== 'preview' ||
    [
      'MCP_OAUTH_ENVIRONMENT',
      'MCP_OAUTH_PREVIEW_BRANCH',
      'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
      'OAUTH_AUTHORIZATION_SERVER_URI',
      'MCP_CANONICAL_RESOURCE_URI',
    ].some((key) => read(key))
  )
    return false;

  return (
    resolveDayoptEnvironment({
      dayoptEnvironment: read('DAYOPT_ENVIRONMENT'),
      publicDayoptEnvironment: read('NEXT_PUBLIC_DAYOPT_ENVIRONMENT'),
      vercelEnvironment: read('VERCEL_ENV'),
      vercelTargetEnvironment: read('VERCEL_TARGET_ENV'),
      vercelProjectId: read('VERCEL_PROJECT_ID'),
      vercelGitCommitRef: read('VERCEL_GIT_COMMIT_REF'),
      vercelUrl: read('VERCEL_URL'),
      vercelBranchUrl: read('VERCEL_BRANCH_URL'),
      appUrl: read('NEXT_PUBLIC_APP_URL'),
      supabaseUrl: read('NEXT_PUBLIC_SUPABASE_URL'),
    }) === 'preview'
  );
}
