/**
 * Product environment identity, kept separate from Vercel's deployment target.
 * Vercel reports the persistent Integration project as `production`; Dayopt
 * still treats it as non-production and binds it to one exact Supabase branch.
 */

export type DayoptEnvironment =
  'production' | 'preview' | 'integration' | 'development' | 'unknown';

export const PRODUCT_INTEGRATION_APP_ORIGIN = 'https://product-integration-dayopt.vercel.app';
export const PRODUCT_INTEGRATION_SUPABASE_REF = 'tilwaprottpyhlfoggbb';

interface DayoptEnvironmentInput {
  dayoptEnvironment?: string | undefined;
  publicDayoptEnvironment?: string | undefined;
  vercelEnvironment?: string | undefined;
  vercelTargetEnvironment?: string | undefined;
  vercelGitCommitRef?: string | undefined;
  supabaseUrl?: string | undefined;
}

export function resolveDayoptEnvironment(input: DayoptEnvironmentInput): DayoptEnvironment {
  const dayoptMarker = normalize(input.dayoptEnvironment);
  const publicMarker = normalize(input.publicDayoptEnvironment);
  if (dayoptMarker && publicMarker && dayoptMarker !== publicMarker) return 'unknown';

  const marker = dayoptMarker ?? publicMarker;
  const vercelEnvironment = normalize(input.vercelEnvironment);
  const vercelTargetEnvironment = normalize(input.vercelTargetEnvironment);
  const vercelGitCommitRef = normalize(input.vercelGitCommitRef);
  const supabaseProjectRef = resolveSupabaseProjectRef(input.supabaseUrl);

  if (supabaseProjectRef === PRODUCT_INTEGRATION_SUPABASE_REF) {
    if (
      marker !== 'integration' ||
      vercelEnvironment !== 'production' ||
      vercelTargetEnvironment !== 'production' ||
      vercelGitCommitRef !== 'integration'
    )
      return 'unknown';
    return 'integration';
  }

  if (marker === 'integration' || publicMarker === 'integration') return 'unknown';
  if (marker && !isDayoptEnvironment(marker)) return 'unknown';
  if (marker === 'production' && vercelEnvironment && vercelEnvironment !== 'production') {
    return 'unknown';
  }
  if (marker === 'preview' && vercelEnvironment && vercelEnvironment !== 'preview') {
    return 'unknown';
  }
  if (
    marker === 'development' &&
    (vercelEnvironment === 'production' || vercelEnvironment === 'preview')
  ) {
    return 'unknown';
  }

  if (marker) return isDayoptEnvironment(marker) ? marker : 'unknown';
  if (vercelEnvironment === 'production') return 'production';
  if (vercelEnvironment === 'preview') return 'preview';
  return 'development';
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
