const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const CSP_REPORT_URI = '/api/csp-report';

/** Build the public Website CSP from fixed providers and the exact configured Sentry origin. */
export function buildWebContentSecurityPolicy({
  isDevelopment,
  sentryIngestOrigin,
  posthogEnabled = false,
}) {
  const scriptSources = [
    "'self'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
    "'unsafe-inline'",
    'https://vercel.live',
    'https://va.vercel-scripts.com',
    TURNSTILE_ORIGIN,
  ].join(' ');
  const connectSources = [
    "'self'",
    'https://vercel.live',
    'https://vitals.vercel-insights.com',
    ...(sentryIngestOrigin ? [sentryIngestOrigin] : []),
    ...(posthogEnabled ? ['https://us.i.posthog.com'] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    `frame-src 'self' https://vercel.live ${TURNSTILE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
    `report-uri ${CSP_REPORT_URI}`,
  ].join('; ');
}
