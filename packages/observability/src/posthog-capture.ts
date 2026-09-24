/** A narrow contract for optional browser analytics; unknown SDK events are dropped. */
const EVENT_NAMES = new Set([
  '$pageview',
  '$identify',
  'signup_cta_clicked',
  'signup_viewed',
  'signup_completed',
  'review_opened',
]);

const PROPERTY_NAMES = new Set([
  'token',
  'distinct_id',
  '$anon_distinct_id',
  '$device_id',
  '$session_id',
  '$process_person_profile',
  'environment',
  'surface',
  'schema_version',
  'page_path',
  'cta_id',
  'signup_method',
  'screen',
  'language',
  'device_category',
  'referrer_domain',
  'first_referrer_domain',
  'last_referrer_domain',
  'first_utm_source',
  'first_utm_medium',
  'first_utm_campaign',
  'last_utm_source',
  'last_utm_medium',
  'last_utm_campaign',
  '$current_url',
  '$pathname',
  '$referrer',
  '$referring_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  '$utm_source',
  '$utm_medium',
  '$utm_campaign',
]);

const FIXED_VALUES: Record<string, ReadonlySet<string>> = {
  environment: new Set(['production', 'preview', 'development']),
  surface: new Set(['web', 'product']),
  cta_id: new Set(['header_desktop', 'header_mobile', 'hero', 'pricing_free', 'pricing_pro']),
  signup_method: new Set(['email', 'google']),
  screen: new Set(['signup', 'review']),
  language: new Set(['ja', 'en']),
  device_category: new Set(['mobile', 'desktop']),
};

/** Public site path only. Dynamic or encoded path segments are replaced. */
export function postHogPagePath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, 6);
  const safe = segments.map((segment) =>
    /^[a-z0-9-]{1,80}$/i.test(segment) && !/^[0-9a-f]{16,}$/i.test(segment)
      ? segment.toLowerCase()
      : ':page',
  );
  return safe.length ? `/${safe.join('/')}` : '/';
}

export function postHogUtm(value: string | null): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^[a-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

export function postHogExternalReferrer(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (hostname === 'dayopt.app' || hostname.endsWith('.dayopt.app')) return undefined;
    return hostname.length <= 120 && /^[a-z0-9.-]+$/.test(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Runs in the SDK's before_send hook, including for events added by a future SDK version. */
export function filterPostHogBrowserProperties(
  eventName: string,
  properties: Record<string, unknown>,
  origin: string,
): Record<string, unknown> | null {
  if (!EVENT_NAMES.has(eventName)) return null;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!PROPERTY_NAMES.has(key)) continue;
    if (key === 'schema_version') {
      if (value === 1) filtered[key] = 1;
    } else if (key in FIXED_VALUES) {
      if (typeof value === 'string' && FIXED_VALUES[key]?.has(value)) filtered[key] = value;
    } else if (key === '$current_url') {
      try {
        const currentUrl = new URL(String(value), origin);
        if (currentUrl.origin !== origin) return null;
        filtered[key] = `${origin}${postHogPagePath(currentUrl.pathname)}`;
      } catch {
        return null;
      }
    } else if (key === '$pathname' || key === 'page_path') {
      filtered[key] = postHogPagePath(String(value));
    } else if (key === '$referrer') {
      const domain = postHogExternalReferrer(String(value));
      if (domain) filtered[key] = `https://${domain}/`;
    } else if (key === '$referring_domain' || key.endsWith('referrer_domain')) {
      const domain = postHogExternalReferrer(`https://${String(value)}/`);
      if (domain) filtered[key] = domain;
    } else if (key.startsWith('utm_') || key.startsWith('$utm_') || key.includes('_utm_')) {
      const utm = postHogUtm(String(value));
      if (utm) filtered[key] = utm;
    } else if (typeof value === 'string' && value.length > 128) {
      continue;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
}
