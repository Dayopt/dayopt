/**
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY` は Turnstile widget の描画に必須。欠けても
 * `src/lib/turnstile/config.ts` の `|| ''` により build は通るが、`isTurnstileEnabled()`
 * が false になって widget が描画されず、captchaToken 無しで signIn する。production の
 * Supabase Auth Bot Protection は全リクエストを captcha_failed で拒否するため、login /
 * signup / password reset が全滅する（#1924）。値の欠落を検知する手段が他に無いので
 * production build の必須 env に含める。
 *
 * `RECOVERY_CODE_PEPPER` は 2026-08-17、production で空文字のまま放置されているのを検出した
 * （#2115）。Preview 必須リストには元から入っていたが production 側は漏れており、
 * `src/env.ts` の `NODE_ENV === 'production'` refine は runtime の初回アクセス時にしか評価
 * されないため、recovery code が実際に使われるまで欠落が顕在化しなかった。build gate は
 * deploy 前に落ちるため、未使用パスに依存せず検知できる。
 */
export const REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV = [
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RECOVERY_CODE_PEPPER',
];

export const REQUIRED_PRODUCT_PREVIEW_BUILD_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RECOVERY_CODE_PEPPER',
  'MCP_OAUTH_ENVIRONMENT',
  'MCP_OAUTH_PREVIEW_BRANCH',
  'MCP_OAUTH_PREVIEW_UPSTASH_HOST',
  'OAUTH_AUTHORIZATION_SERVER_URI',
  'MCP_CANONICAL_RESOURCE_URI',
  'NEXT_PUBLIC_APP_URL',
  'VERCEL_BRANCH_URL',
  'VERCEL_GIT_COMMIT_REF',
];

export const REQUIRED_PRODUCT_INTEGRATION_BUILD_ENV = [
  'DAYOPT_ENVIRONMENT',
  'NEXT_PUBLIC_DAYOPT_ENVIRONMENT',
  'VERCEL_ENV',
  'VERCEL_TARGET_ENV',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_PROJECT_ID',
  'VERCEL_BRANCH_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_APP_URL',
  'MCP_OAUTH_ENVIRONMENT',
  'OAUTH_AUTHORIZATION_SERVER_URI',
  'MCP_CANONICAL_RESOURCE_URI',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RECOVERY_CODE_PEPPER',
];

/**
 * Persistent Integration remains non-production: only explicitly validated
 * test-only delivery, billing, telemetry, and Calendar settings may be present.
 */
export const FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV = [
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_DSN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SENTRY_AUTH_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID',
  'STRIPE_ACCOUNT_ID',
  'STRIPE_LIVEMODE',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_PROJECT_NUMBER',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'CALENDAR_TOKEN_ENCRYPTION_KEY',
  'GOOGLE_CALENDAR_REDIRECT_URIS',
  'CRON_SECRET',
];

/**
 * Secret key は apikey として gateway が検証する。opaque key 自体が JWT でないことは
 * Auth の admin 権限が失われる根拠にはならない（#2517）。この検査は公開キーや
 * 不明な形式の取り違えを止めるだけで、接続先・有効性・captcha 免除を証明しない。
 * Production 切替前の captcha 有効環境での再認証検証は docs/product/specs/auth.md を参照。
 */
function assertServerSupabaseKey(env) {
  const value = env.SUPABASE_SECRET_KEY;
  if (typeof value !== 'string') return;
  const normalized = value.replace(/\\n/gu, '').trim();
  if (normalized === '') return;

  if (!/^sb_secret_[A-Za-z0-9_-]+$/u.test(normalized) && !normalized.startsWith('eyJ')) {
    throw new Error(
      'Product production build requires a server-only SUPABASE_SECRET_KEY ' +
        '(opaque secret key or legacy service-role JWT). Verify password reauthentication ' +
        'with captcha enabled before Production key rotation.',
    );
  }
}

/** Classify the exact value bundled by Next.js; never normalize a public credential. */
function assertPublicSupabaseKey(env) {
  const value = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (typeof value === 'string') {
    if (/^sb_publishable_[A-Za-z0-9_-]+$/u.test(value) && value === value.trim()) return;

    // Legacy anon keys are HS256 JWTs. This checks format and role, not signature
    // authenticity or project binding, which remain the Supabase gateway's job.
    const parts = value.split('.');
    if (
      parts.length === 3 &&
      parts.every(
        (part) =>
          /^[A-Za-z0-9_-]+$/u.test(part) &&
          Buffer.from(part, 'base64url').toString('base64url') === part,
      )
    ) {
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (
          header?.alg === 'HS256' &&
          header?.typ === 'JWT' &&
          payload?.role === 'anon' &&
          Buffer.from(parts[2], 'base64url').length === 32
        ) {
          return;
        }
      } catch {
        // Malformed JWTs fail with the same value-free error as privileged keys.
      }
    }
  }
  throw new Error(
    'Product deployment requires a public NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ' +
      '(publishable key or legacy anon JWT)',
  );
}

export const PRODUCT_PRODUCTION_ORIGIN = 'https://app.dayopt.app';
export const MCP_PRODUCTION_ORIGIN = 'https://mcp.dayopt.app';
export const PRODUCT_INTEGRATION_ORIGIN = 'https://product-git-integration-dayopt.vercel.app';
export const PRODUCT_INTEGRATION_HOST = 'product-git-integration-dayopt.vercel.app';
export const PRODUCT_INTEGRATION_SUPABASE_HOST = 'tilwaprottpyhlfoggbb.supabase.co';
export const PRODUCT_VERCEL_PROJECT_ID = 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa';
export const PRODUCT_INTEGRATION_SUPABASE_REF = 'tilwaprottpyhlfoggbb';
export const PRODUCT_INTEGRATION_APP_ORIGIN = PRODUCT_INTEGRATION_ORIGIN;
const PRODUCT_INTEGRATION_BRANCH = 'integration';
const PRODUCT_INTEGRATION_BRANCH_HOST = PRODUCT_INTEGRATION_HOST;
const PRODUCT_PREVIEW_DEPLOYMENT_HOST_PATTERN = /^product-[a-z0-9-]+-dayopt\.vercel\.app$/u;
const PRODUCTION_SUPABASE_HOST = 'yvglwblxrnrenfifsnje.supabase.co';
const PRODUCT_PREVIEW_BRANCH_HOST_PATTERN = /^product-git-[a-z0-9-]+-dayopt\.vercel\.app$/u;

/**
 * Expose only the MCP resource owned by this deploy to client components.
 *
 * Generic Preview and other Vercel environments do not own a stable OAuth
 * surface, so they must not advertise the Production URL. Local development
 * (no VERCEL_ENV) does not own any MCP resource either, so it advertises
 * nothing and the Settings connection section stays hidden.
 * The build assertions run before this resolver in next.config.mjs.
 */
export function resolveProductPublicMcpResourceUri(env) {
  if (isProductIntegrationConfigured(env)) {
    return isBoundProductIntegration(env) ? PRODUCT_INTEGRATION_ORIGIN : '';
  }
  if (env.VERCEL_ENV === 'production') return MCP_PRODUCTION_ORIGIN;
  if (
    env.VERCEL_ENV === 'preview' &&
    env.VERCEL_TARGET_ENV === 'preview' &&
    env.MCP_OAUTH_ENVIRONMENT === 'preview' &&
    hasNonEmptyValue(env, 'VERCEL_BRANCH_URL')
  ) {
    return `https://${env.VERCEL_BRANCH_URL}`;
  }
  return '';
}

function isProductIntegrationConfigured(env) {
  return (
    env.DAYOPT_ENVIRONMENT === 'integration' ||
    env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration' ||
    env.MCP_OAUTH_ENVIRONMENT === 'integration' ||
    env.VERCEL_GIT_COMMIT_REF === 'integration'
  );
}

function isBoundProductIntegration(env) {
  return (
    env.DAYOPT_ENVIRONMENT === 'integration' &&
    env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration' &&
    env.VERCEL_ENV === 'preview' &&
    env.VERCEL_TARGET_ENV === 'preview' &&
    env.VERCEL_PROJECT_ID === PRODUCT_VERCEL_PROJECT_ID &&
    env.VERCEL_GIT_COMMIT_REF === 'integration' &&
    env.VERCEL_BRANCH_URL === PRODUCT_INTEGRATION_HOST &&
    env.NEXT_PUBLIC_APP_URL === PRODUCT_INTEGRATION_ORIGIN &&
    env.NEXT_PUBLIC_SUPABASE_URL === `https://${PRODUCT_INTEGRATION_SUPABASE_HOST}` &&
    env.MCP_OAUTH_ENVIRONMENT === 'integration' &&
    env.OAUTH_AUTHORIZATION_SERVER_URI === PRODUCT_INTEGRATION_ORIGIN &&
    env.MCP_CANONICAL_RESOURCE_URI === PRODUCT_INTEGRATION_ORIGIN
  );
}

/** Validate the fixed always-on Integration project before accepting its Vercel Preview build. */
export function assertProductIntegrationBuildEnv(env) {
  if (!isProductIntegrationConfigured(env)) return false;

  const missingNames = REQUIRED_PRODUCT_INTEGRATION_BUILD_ENV.filter(
    (name) => !hasNonEmptyValue(env, name),
  );
  if (missingNames.length > 0) {
    throw new Error(`Product Integration build requires: ${missingNames.join(', ')}`);
  }

  if (!isBoundProductIntegration(env)) {
    throw new Error(
      'Product Integration build requires its fixed domain, Product project, integration Git branch, Preview target, OAuth identity, and Supabase project',
    );
  }

  assertServerSupabaseKey(env);
  assertHttpsUrl(env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL', 'Integration');

  const upstashHost = new URL(env.UPSTASH_REDIS_REST_URL).hostname;
  if (upstashHost === 'localhost' || upstashHost === '127.0.0.1') {
    throw new Error('Product Integration requires a hosted, environment-specific Upstash instance');
  }

  if (env.MCP_WRITE_ENABLED_CLIENTS?.trim()) {
    throw new Error('Product Integration build requires MCP_WRITE_ENABLED_CLIENTS to be empty');
  }
  if (env.BILLING_ENFORCED === 'true') {
    throw new Error('Product Integration build forbids BILLING_ENFORCED=true');
  }
  if (env.POSTHOG_SERVER_ENABLED === 'true' || env.NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED === 'true') {
    throw new Error('Product Integration build forbids PostHog event delivery');
  }

  const stripeKey = typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY.trim() : '';
  if (
    (stripeKey && !stripeKey.startsWith('sk_test_') && !stripeKey.startsWith('rk_test_')) ||
    (stripeKey && env.STRIPE_LIVEMODE !== 'false') ||
    (!stripeKey && env.STRIPE_LIVEMODE === 'true')
  ) {
    throw new Error('Product Integration build allows only Stripe test-mode credentials');
  }
  assertOptionalEnvironmentGroup(env, 'Product Integration Stripe configuration', [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]);

  const contactRecipient =
    typeof env.CONTACT_INTEGRATION_RECIPIENT === 'string'
      ? env.CONTACT_INTEGRATION_RECIPIENT.trim().toLowerCase()
      : '';
  if (
    hasNonEmptyValue(env, 'RESEND_API_KEY') &&
    (!isValidEmailAddress(contactRecipient) || contactRecipient === 'support@dayopt.app')
  ) {
    throw new Error(
      'Product Integration with Resend requires a dedicated CONTACT_INTEGRATION_RECIPIENT',
    );
  }
  assertOptionalEnvironmentGroup(env, 'Product Integration Resend configuration', [
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'RESEND_WEBHOOK_SECRET',
    'CONTACT_INTEGRATION_RECIPIENT',
  ]);
  assertOptionalEnvironmentGroup(env, 'Product Integration Calendar configuration', [
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_PROJECT_NUMBER',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'CALENDAR_TOKEN_ENCRYPTION_KEY',
    'GOOGLE_CALENDAR_REDIRECT_URIS',
  ]);

  if (
    hasNonEmptyValue(env, 'GOOGLE_CALENDAR_CLIENT_ID') &&
    env.GOOGLE_CALENDAR_REDIRECT_URIS !==
      `${PRODUCT_INTEGRATION_ORIGIN}/api/integrations/google-calendar/callback`
  ) {
    throw new Error('Product Integration Calendar redirect URI must match its fixed callback');
  }

  return true;
}

function assertOptionalEnvironmentGroup(env, label, names) {
  const configured = names.filter((name) => hasNonEmptyValue(env, name)).length;
  if (configured > 0 && configured !== names.length) {
    throw new Error(`${label} requires all or none of: ${names.join(', ')}`);
  }
}

function isValidEmailAddress(value) {
  return (
    value.length <= 254 && !/[\r\n,]/u.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
  );
}

function hasNonEmptyValue(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

function resolveProductSupabaseProjectRef(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
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
    return /^([a-z]{20})\.supabase\.co$/u.exec(url.hostname)?.[1];
  } catch {
    return undefined;
  }
}

function assertMatchingDayoptEnvironmentMarkers(env) {
  const allowed = new Set(['production', 'preview', 'integration', 'development']);
  for (const name of ['DAYOPT_ENVIRONMENT', 'NEXT_PUBLIC_DAYOPT_ENVIRONMENT']) {
    if (hasNonEmptyValue(env, name) && !allowed.has(env[name])) {
      throw new Error(`Product deployment requires a supported ${name}`);
    }
  }
  if (
    hasNonEmptyValue(env, 'DAYOPT_ENVIRONMENT') &&
    hasNonEmptyValue(env, 'NEXT_PUBLIC_DAYOPT_ENVIRONMENT') &&
    env.DAYOPT_ENVIRONMENT !== env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT
  ) {
    throw new Error('Product deployment requires matching Dayopt environment markers');
  }
}

function assertPreviewAppUrlMatchesVercel(env) {
  if (!hasNonEmptyValue(env, 'NEXT_PUBLIC_APP_URL')) return;
  const expectedHosts = [env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(
    (host) =>
      typeof host === 'string' &&
      (PRODUCT_PREVIEW_BRANCH_HOST_PATTERN.test(host) ||
        PRODUCT_PREVIEW_DEPLOYMENT_HOST_PATTERN.test(host)),
  );
  let url;
  try {
    url = new URL(env.NEXT_PUBLIC_APP_URL);
  } catch {
    throw new Error('Product Preview requires NEXT_PUBLIC_APP_URL to match its Vercel URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !expectedHosts.some((host) => url.origin === `https://${host}`)
  ) {
    throw new Error('Product Preview requires NEXT_PUBLIC_APP_URL to match its Vercel URL');
  }
}

/**
 * Bind the application environment to its database without treating a shared
 * nonproduction Supabase ref as proof that the app itself is Integration.
 * This catches missing Preview wiring and accidental Production DB reuse at build time.
 */
export function assertProductDeploymentEnvironmentBuildEnv(env) {
  const vercelEnvironment = env.VERCEL_ENV;
  if (vercelEnvironment !== 'preview' && vercelEnvironment !== 'production') return false;

  assertMatchingDayoptEnvironmentMarkers(env);

  const missingNames = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
    'RECOVERY_CODE_PEPPER',
  ].filter((name) => !hasNonEmptyValue(env, name));
  if (missingNames.length > 0) {
    throw new Error(`Product ${vercelEnvironment} build requires: ${missingNames.join(', ')}`);
  }

  const projectRef = resolveProductSupabaseProjectRef(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!projectRef) {
    throw new Error('Product deployment requires a canonical HTTPS Supabase project URL');
  }
  assertPublicSupabaseKey(env);
  assertServerSupabaseKey(env, vercelEnvironment);

  const appMarker = env.DAYOPT_ENVIRONMENT || env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT;
  if (vercelEnvironment === 'preview') {
    if (env.VERCEL_PROJECT_ID !== PRODUCT_VERCEL_PROJECT_ID) {
      throw new Error('Product Preview build requires the Product Vercel project');
    }
    if (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== 'preview') {
      throw new Error('Product Preview build requires the Vercel Preview target');
    }

    const integrationMarker =
      env.DAYOPT_ENVIRONMENT === 'integration' &&
      env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration';
    const integrationBranch = env.VERCEL_GIT_COMMIT_REF === PRODUCT_INTEGRATION_BRANCH;
    if (integrationMarker || integrationBranch) {
      if (
        !integrationMarker ||
        !integrationBranch ||
        env.VERCEL_PROJECT_ID !== PRODUCT_VERCEL_PROJECT_ID ||
        projectRef !== PRODUCT_INTEGRATION_SUPABASE_REF ||
        env.VERCEL_BRANCH_URL !== PRODUCT_INTEGRATION_BRANCH_HOST ||
        env.NEXT_PUBLIC_APP_URL !== PRODUCT_INTEGRATION_APP_ORIGIN
      ) {
        throw new Error(
          'Product Integration build requires matching markers, Product project, integration branch, persistent Supabase ref, and fixed Vercel branch URL',
        );
      }
    }

    if (appMarker && appMarker !== 'preview') {
      if (!integrationMarker) {
        throw new Error('Product Preview build requires the Preview application identity');
      }
    }
    if (projectRef === 'yvglwblxrnrenfifsnje') {
      throw new Error('Product Preview build forbids the Production Supabase project');
    }
    assertPreviewAppUrlMatchesVercel(env);

    const forbiddenNames = FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV.filter(
      (name) => !integrationMarker && name !== 'RESEND_FROM_EMAIL' && hasNonEmptyValue(env, name),
    );
    if (forbiddenNames.length > 0) {
      throw new Error(`Product Preview build forbids: ${forbiddenNames.join(', ')}`);
    }
    if (env.MCP_OAUTH_ENVIRONMENT === 'production') {
      throw new Error('Product Preview build forbids the Production MCP OAuth identity');
    }
    if (
      projectRef === PRODUCT_INTEGRATION_SUPABASE_REF &&
      !integrationMarker &&
      (env.MCP_OAUTH_ENVIRONMENT === 'preview' ||
        hasNonEmptyValue(env, 'OAUTH_AUTHORIZATION_SERVER_URI') ||
        hasNonEmptyValue(env, 'MCP_CANONICAL_RESOURCE_URI') ||
        hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_BRANCH') ||
        hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_UPSTASH_HOST'))
    ) {
      throw new Error(
        'Product Preview sharing Integration Supabase cannot own an MCP OAuth identity',
      );
    }
    if (env.BILLING_ENFORCED === 'true') {
      throw new Error('Product Preview build forbids BILLING_ENFORCED=true');
    }
    if (hasNonEmptyValue(env, 'MCP_WRITE_ENABLED_CLIENTS')) {
      throw new Error('Product Preview build requires MCP_WRITE_ENABLED_CLIENTS to be empty');
    }
    return true;
  }

  if (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== 'production') {
    throw new Error('Product Production build requires the Vercel Production target');
  }

  if (projectRef === 'yvglwblxrnrenfifsnje') {
    if (appMarker && appMarker !== 'production') {
      throw new Error('Product Production build requires the Production application identity');
    }
    if (env.VERCEL_GIT_COMMIT_REF !== 'main') {
      throw new Error('Product Production Supabase is reserved for the main Git branch');
    }
    return true;
  }

  throw new Error('Product Production build requires its bound Production Supabase project');
}

function isVerifiedDayoptSender(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254) return false;
  if (normalized === 'onboarding@resend.dev') return false;

  const parts = normalized.split('@');
  if (parts.length !== 2) return false;
  const [localPart, domain] = parts;
  if (
    !localPart ||
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(localPart)
  ) {
    return false;
  }

  return domain === 'dayopt.app';
}

/** Prevent a Production deploy with unavailable delivery, monitoring, or abuse controls. */
export function assertProductOperationalProductionBuildEnv(env) {
  if (env.VERCEL_ENV !== 'production' || isProductIntegrationConfigured(env)) return false;

  // Integration was validated above and skipped here. Reject an unknown Vercel
  // target or non-Production identity instead of silently treating it as Production.
  if (
    env.VERCEL_TARGET_ENV === 'staging' ||
    hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_BRANCH') ||
    hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_UPSTASH_HOST') ||
    (hasNonEmptyValue(env, 'MCP_OAUTH_ENVIRONMENT') &&
      env.MCP_OAUTH_ENVIRONMENT !== 'production') ||
    (hasNonEmptyValue(env, 'OAUTH_AUTHORIZATION_SERVER_URI') &&
      env.OAUTH_AUTHORIZATION_SERVER_URI !== PRODUCT_PRODUCTION_ORIGIN) ||
    (hasNonEmptyValue(env, 'MCP_CANONICAL_RESOURCE_URI') &&
      env.MCP_CANONICAL_RESOURCE_URI !== MCP_PRODUCTION_ORIGIN)
  ) {
    throw new Error('Product production build cannot use a non-Production OAuth identity');
  }

  const missingNames = REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV.filter(
    (name) => typeof env[name] !== 'string' || env[name].trim() === '',
  );
  if (missingNames.length > 0) {
    throw new Error(`Product production build requires: ${missingNames.join(', ')}`);
  }

  if (!isVerifiedDayoptSender(env.RESEND_FROM_EMAIL)) {
    throw new Error('Product production build requires an apex dayopt.app RESEND_FROM_EMAIL');
  }

  try {
    const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL);
    if (redisUrl.protocol !== 'https:' || !redisUrl.hostname) throw new Error();
  } catch {
    throw new Error('Product production build requires a valid UPSTASH_REDIS_REST_URL');
  }

  // These names also exist in Preview with branch-specific credentials. Keep
  // them out of the Production-only operational audit contract above.
  const missingSupabase = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ].filter((name) => !hasNonEmptyValue(env, name));
  if (missingSupabase.length > 0) {
    throw new Error(`Product production build requires: ${missingSupabase.join(', ')}`);
  }
  assertServerSupabaseKey(env);

  return true;
}

/**
 * Enable OAuth only for one explicit standard Preview branch. Other Preview
 * deployments keep the generic OAuth surface disabled.
 */
export function assertProductPreviewBuildEnv(env) {
  const previewMarkerConfigured =
    env.MCP_OAUTH_ENVIRONMENT === 'preview' ||
    hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_BRANCH') ||
    hasNonEmptyValue(env, 'MCP_OAUTH_PREVIEW_UPSTASH_HOST');
  if (!previewMarkerConfigured) return false;

  if (env.VERCEL_ENV !== 'preview' || env.VERCEL_TARGET_ENV !== 'preview') {
    throw new Error(
      'Product MCP preview build requires VERCEL_ENV=preview and VERCEL_TARGET_ENV=preview',
    );
  }

  const missingNames = REQUIRED_PRODUCT_PREVIEW_BUILD_ENV.filter(
    (name) => !hasNonEmptyValue(env, name),
  );
  if (missingNames.length > 0) {
    throw new Error(`Product MCP preview build requires: ${missingNames.join(', ')}`);
  }

  const forbiddenNames = FORBIDDEN_PRODUCT_PREVIEW_BUILD_ENV.filter((name) =>
    hasNonEmptyValue(env, name),
  );
  if (forbiddenNames.length > 0) {
    throw new Error(`Product MCP preview build forbids: ${forbiddenNames.join(', ')}`);
  }

  if (env.BILLING_ENFORCED === 'true') {
    throw new Error('Product MCP preview build forbids BILLING_ENFORCED=true');
  }
  if (hasNonEmptyValue(env, 'MCP_WRITE_ENABLED_CLIENTS')) {
    throw new Error('Product MCP preview build requires MCP_WRITE_ENABLED_CLIENTS to be empty');
  }
  if (env.VERCEL_GIT_COMMIT_REF !== env.MCP_OAUTH_PREVIEW_BRANCH) {
    throw new Error('Product MCP preview build requires the exact configured Vercel branch');
  }

  const previewOrigin = resolveStablePreviewOrigin(env.VERCEL_BRANCH_URL);
  for (const name of [
    'OAUTH_AUTHORIZATION_SERVER_URI',
    'MCP_CANONICAL_RESOURCE_URI',
    'NEXT_PUBLIC_APP_URL',
  ]) {
    if (env[name] !== previewOrigin) {
      throw new Error(`Product MCP preview build requires ${name} to match VERCEL_BRANCH_URL`);
    }
  }

  assertNonProductionSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL, 'MCP preview');
  assertHttpsUrl(env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL', 'MCP preview');
  const upstashHost = new URL(env.UPSTASH_REDIS_REST_URL).hostname;
  if (upstashHost !== env.MCP_OAUTH_PREVIEW_UPSTASH_HOST) {
    throw new Error('Product MCP preview build requires the exact Preview Upstash instance host');
  }

  return true;
}

function assertNonProductionSupabaseUrl(value, environmentLabel) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Product ${environmentLabel} build requires a valid NEXT_PUBLIC_SUPABASE_URL`);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith('.supabase.co') ||
    url.hostname === PRODUCTION_SUPABASE_HOST
  ) {
    throw new Error(
      `Product ${environmentLabel} build requires a non-Production Supabase branch API origin`,
    );
  }
}

function assertHttpsUrl(value, name, environmentLabel) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error();
  } catch {
    throw new Error(`Product ${environmentLabel} build requires a valid ${name}`);
  }
}

function resolveStablePreviewOrigin(value) {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.includes('..') ||
    !PRODUCT_PREVIEW_BRANCH_HOST_PATTERN.test(value)
  ) {
    throw new Error('Product MCP preview build requires the stable Product branch alias');
  }

  return `https://${value}`;
}
