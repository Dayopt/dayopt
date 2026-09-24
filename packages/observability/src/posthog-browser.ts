import {
  filterPostHogBrowserProperties,
  postHogExternalReferrer,
  postHogPageLanguage,
  postHogPagePath,
  postHogUtm,
} from './posthog-capture';

type Surface = 'web' | 'product';
type Environment = 'production' | 'preview' | 'development';
type BrowserEvent = 'signup_cta_clicked' | 'signup_viewed' | 'review_opened';

interface BrowserAnalyticsOptions {
  projectKey: string;
  environment: Environment;
  surface: Surface;
  hasConsent: () => boolean;
}

type PostHogBrowser = (typeof import('posthog-js'))['default'];

let client: PostHogBrowser | null = null;
let loading: Promise<void> | null = null;
let enabled = false;
let persistenceDisabledAfterRevocation = false;
let consentCheck: (() => boolean) | null = null;
let pendingCaptures: Array<() => void> = [];
let commonProperties: { environment: Environment; surface: Surface; schema_version: 1 } | null =
  null;

function flushPendingCaptures(): void {
  const queued = pendingCaptures;
  pendingCaptures = [];
  if (!enabled || !consentCheck?.()) return;
  for (const capture of queued) capture();
}

/** Initialize only after this origin has explicitly allowed analytics. */
export async function startPostHogBrowser(options: BrowserAnalyticsOptions): Promise<void> {
  if (!options.projectKey || !options.hasConsent()) return;
  consentCheck = options.hasConsent;
  commonProperties = {
    environment: options.environment,
    surface: options.surface,
    schema_version: 1,
  };
  enabled = true;
  if (client) {
    if (persistenceDisabledAfterRevocation) {
      client.persistence?.set_disabled(false);
      client.sessionPersistence?.set_disabled(false);
      client.opt_in_capturing({ captureEventName: false });
      persistenceDisabledAfterRevocation = false;
    }
    flushPendingCaptures();
    return;
  }
  if (loading) return loading;

  loading = import('posthog-js')
    .then(({ default: posthog }) => {
      if (!enabled || !consentCheck?.()) return;
      posthog.init(options.projectKey, {
        api_host: 'https://us.i.posthog.com',
        autocapture: false,
        rageclick: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
        advanced_disable_feature_flags: true,
        person_profiles: 'identified_only',
        persistence: 'cookie',
        cross_subdomain_cookie: true,
        before_send: (event) => {
          if (!event || !enabled || !consentCheck?.()) return null;
          const properties = filterPostHogBrowserProperties(
            event.event,
            event.properties,
            window.location.origin,
          );
          if (!properties) return null;
          const clean = { ...event, properties };
          delete clean.$set;
          delete clean.$set_once;
          delete clean.$unset;
          return clean;
        },
      });
      client = posthog;
      flushPendingCaptures();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Clears the shared Dayopt cookie so another account never inherits this identity. */
export function stopPostHogBrowser(): void {
  enabled = false;
  pendingCaptures = [];
  client?.opt_out_capturing();
  client?.persistence?.clear();
  client?.sessionPersistence?.clear();
  client?.clear_opt_in_out_capturing();
  client?.persistence?.set_disabled(true);
  client?.sessionPersistence?.set_disabled(true);
  persistenceDisabledAfterRevocation = client !== null;
}

export function identifyPostHogBrowser(userId: string): void {
  if (!enabled || !consentCheck?.() || !client) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return;
  client.identify(userId);
}

/** Drops any identity persisted by a previous auth session while retaining consent. */
export function resetPostHogBrowserIdentity(): void {
  if (!enabled || !consentCheck?.() || !client) return;
  client.reset();
}

function attributionProperties(): Record<string, string> {
  const properties: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const name of ['source', 'medium', 'campaign'] as const) {
    const value = postHogUtm(params.get(`utm_${name}`));
    if (value) {
      properties[`utm_${name}`] = value;
      properties[`$utm_${name}`] = value;
      properties[`last_utm_${name}`] = value;
      client?.register_once({ [`first_utm_${name}`]: value });
    }
  }
  const referrerDomain = postHogExternalReferrer(document.referrer);
  if (referrerDomain) {
    properties.referrer_domain = referrerDomain;
    client?.register_once({ first_referrer_domain: referrerDomain });
    client?.register({ last_referrer_domain: referrerDomain });
  }
  if (Object.keys(properties).length) client?.register(properties);
  return properties;
}

export function capturePostHogPageview(): void {
  if (!enabled || !consentCheck?.() || !commonProperties) return;
  if (!client) {
    if (pendingCaptures.length < 20) pendingCaptures.push(capturePostHogPageview);
    return;
  }
  const pagePath = postHogPagePath(window.location.pathname);
  const attribution = attributionProperties();
  client.capture('$pageview', {
    ...commonProperties,
    ...attribution,
    page_path: pagePath,
    $pathname: pagePath,
    $current_url: `${window.location.origin}${pagePath}`,
    language: postHogPageLanguage(pagePath),
    device_category: window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop',
  });
}

export function capturePostHogBrowserEvent(
  eventName: BrowserEvent,
  properties: Record<string, string> = {},
): void {
  if (!enabled || !consentCheck?.() || !commonProperties) return;
  if (!client) {
    if (pendingCaptures.length < 20) {
      pendingCaptures.push(() => capturePostHogBrowserEvent(eventName, properties));
    }
    return;
  }
  client.capture(
    eventName,
    { ...commonProperties, ...properties },
    eventName === 'signup_cta_clicked'
      ? { send_instantly: true, transport: 'sendBeacon' }
      : undefined,
  );
}
