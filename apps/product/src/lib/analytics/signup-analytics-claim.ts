import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SIGNUP_ANALYTICS_CLAIM_COOKIE = '__Host-dayopt_signup_claim';
export const SIGNUP_ANALYTICS_CLAIM_MAX_AGE_SECONDS = 10 * 60;

export type SignupAnalyticsMethod = 'email' | 'google';

interface SignupAnalyticsClaim {
  version: 1;
  subject: string;
  method: SignupAnalyticsMethod;
  issuedAt: number;
  nonce: string;
}

function signingKey(): string | null {
  return process.env.SUPABASE_SECRET_KEY ?? null;
}

function subjectFor(userId: string, key: string): string {
  return createHmac('sha256', key)
    .update(`dayopt:posthog-signup-subject:v1:${userId}`)
    .digest('base64url');
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key)
    .update(`dayopt:posthog-signup-claim:v1:${payload}`)
    .digest('base64url');
}

function isSignupAnalyticsClaim(value: unknown): value is SignupAnalyticsClaim {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Partial<SignupAnalyticsClaim>;
  return (
    claim.version === 1 &&
    typeof claim.subject === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(claim.subject) &&
    (claim.method === 'email' || claim.method === 'google') &&
    typeof claim.issuedAt === 'number' &&
    Number.isSafeInteger(claim.issuedAt) &&
    typeof claim.nonce === 'string' &&
    /^[0-9a-f-]{36}$/i.test(claim.nonce)
  );
}

/** Returns a short-lived signed claim only from a server-verified signup callback. */
export function createSignupAnalyticsClaim(
  userId: string,
  method: SignupAnalyticsMethod,
  issuedAt = Date.now(),
): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      subject: subjectFor(userId, key),
      method,
      issuedAt,
      nonce: randomUUID(),
    } satisfies SignupAnalyticsClaim),
  ).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** Verifies signature, current account binding, and the short claim lifetime. */
export function verifySignupAnalyticsClaim(
  token: string,
  userId: string,
  now = Date.now(),
): { method: SignupAnalyticsMethod } | null {
  const key = signingKey();
  if (!key || token.length > 1024) return null;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator !== token.lastIndexOf('.')) return null;

  const payload = token.slice(0, separator);
  const signatureText = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signatureText)) return null;
  const providedSignature = Buffer.from(signatureText, 'base64url');
  const expectedSignature = Buffer.from(sign(payload, key), 'base64url');
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isSignupAnalyticsClaim(parsed)) return null;
    if (parsed.subject !== subjectFor(userId, key)) return null;
    if (parsed.issuedAt > now + 60_000) return null;
    if (now - parsed.issuedAt > SIGNUP_ANALYTICS_CLAIM_MAX_AGE_SECONDS * 1_000) return null;
    return { method: parsed.method };
  } catch {
    return null;
  }
}

export function clearedSignupAnalyticsClaimCookie(): string {
  return `${SIGNUP_ANALYTICS_CLAIM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
