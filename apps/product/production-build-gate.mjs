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

/**
 * Persistent Staging は作らない決定に合わせ、Production 専用の delivery / billing /
 * telemetry / Calendar secret を OAuth 有効 Preview へ持ち込ませない。
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

export const PRODUCT_PRODUCTION_ORIGIN = 'https://app.dayopt.app';
export const MCP_PRODUCTION_ORIGIN = 'https://mcp.dayopt.app';
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

function hasNonEmptyValue(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
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
  if (env.VERCEL_ENV !== 'production') return false;

  // Dayopt には staging 環境が無い（Persistent Staging を作らない決定）。存在しない
  // 以上ここへは到達しないが、あとから staging 名の Vercel custom environment が
  // 生えた場合に Production の OAuth identity をそのまま配ってしまう。sink ではなく
  // 明示的な拒否にして、その時は build を止めて設計判断へ戻す。
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
