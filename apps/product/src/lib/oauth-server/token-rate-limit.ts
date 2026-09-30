import 'server-only';

import { logger } from '@/lib/logger';
import {
  oauthTokenClientRateLimit,
  oauthTokenIpRateLimit,
  oauthTokenPreBodyIpRateLimit,
  oauthTokenRefreshIpRateLimit,
  oauthTokenRefreshRateLimit,
} from '@/lib/rate-limit/upstash';
import { extractClientIp } from '@/lib/security/ip-validation';
import { captureUnexpectedError } from '@/lib/sentry';

import type { OAuthClientId } from './redirect-uris';
import { hashToken } from './tokens';

const LOCAL_PRE_BODY_IP_LIMIT = 600;
const LOCAL_IP_LIMIT = 10;
const LOCAL_REFRESH_LIMIT = 30;
const LOCAL_REFRESH_IP_LIMIT = 120;
// 既知のOAuth clientごとに120/分。現行allowlistは3つなので、全体の最大は360/分。
// allowlistを増やす時はこの合計DB admission上限を見直す。
const LOCAL_CLIENT_LIMIT = 120;
const LOCAL_WINDOW_MS = 60_000;
const localRequests = new Map<string, number[]>();

export type OAuthTokenRateLimitState = 'allowed' | 'limited' | 'unavailable';

/**
 * body を読む前に掛ける粗い IP 上限。
 *
 * grant 種別ごとに bucket を分けるには body が要るが、その body 読み取り自体を
 * 無制限にはしない。DB を引く処理はすべてこの後段の上限の内側にある。
 */
export async function checkOAuthTokenPreBodyRateLimit(
  request: Request,
): Promise<OAuthTokenRateLimitState> {
  const ip = extractClientIp(request.headers.get('x-real-ip'));
  return checkRateLimit(
    oauthTokenPreBodyIpRateLimit,
    `pre-body-ip:${ip}`,
    LOCAL_PRE_BODY_IP_LIMIT,
    'check_oauth_token_pre_body_rate_limit',
  );
}

/**
 * grant 種別ごとの上限。最後の budget はOAuth clientごとに分け、1 clientの
 * unauthenticatedな失敗で他clientの token 発行・更新を止めない。
 *
 * - `authorization_code`: IP 単位。ユーザーが同意画面を踏んだ直後にしか来ないので、
 *   IP あたりの頻度はもともと低い
 * - `refresh_token`: **refresh token 単位**。server-side client は全ユーザー分の
 *   refresh を少数の egress IP から送るため、IP 単位だと同一 provider の利用者が
 *   互いの上限を食い合う（#2721 D-01）
 */
export async function checkOAuthTokenGrantRateLimit(
  request: Request,
  clientId: OAuthClientId,
  grant: { type: 'refresh_token'; refreshToken: string } | { type: 'other' },
): Promise<OAuthTokenRateLimitState> {
  const grantState =
    grant.type === 'refresh_token'
      ? await checkRefreshGrantRateLimit(request, grant.refreshToken)
      : await checkRateLimit(
          oauthTokenIpRateLimit,
          `ip:${extractClientIp(request.headers.get('x-real-ip'))}`,
          LOCAL_IP_LIMIT,
          'check_oauth_token_ip_rate_limit',
        );
  if (grantState !== 'allowed') return grantState;

  return checkRateLimit(
    oauthTokenClientRateLimit,
    `client:${clientId}`,
    LOCAL_CLIENT_LIMIT,
    'check_oauth_token_client_rate_limit',
  );
}

/**
 * refresh grant は **IP と token の両方**を通す。
 *
 * bucket key の材料は検証前の body なので、token 単位だけだと攻撃者が毎回別の値を
 * 送って per-token bucket を無限に作れる。IP上限はこの経路の単一送信元負荷を抑え、
 * 別clientの共有budgetを消費しない。共有 egress IP を締め出さないよう、
 * `authorization_code` の10/分より緩くする（#2721 D-01）。
 */
async function checkRefreshGrantRateLimit(
  request: Request,
  refreshToken: string,
): Promise<OAuthTokenRateLimitState> {
  const ipState = await checkRateLimit(
    oauthTokenRefreshIpRateLimit,
    `refresh-ip:${extractClientIp(request.headers.get('x-real-ip'))}`,
    LOCAL_REFRESH_IP_LIMIT,
    'check_oauth_token_refresh_ip_rate_limit',
  );
  if (ipState !== 'allowed') return ipState;

  return checkRateLimit(
    oauthTokenRefreshRateLimit,
    // 平文は bucket key に載せない（upstash 側でも identifier は再度 hash される）。
    `refresh:${hashToken(refreshToken)}`,
    LOCAL_REFRESH_LIMIT,
    'check_oauth_token_refresh_rate_limit',
  );
}

interface OAuthTokenRateLimiter {
  limit(identifier: string): Promise<{ success: boolean }>;
}

async function checkRateLimit(
  limiter: OAuthTokenRateLimiter | null,
  identifier: string,
  localLimit: number,
  operation: string,
): Promise<OAuthTokenRateLimitState> {
  if (!limiter) {
    if (requiresDistributedOAuthTokenRateLimit(process.env)) {
      logger.error('OAuth token rate limit configuration is unavailable');
      return 'unavailable';
    }
    return checkLocalLimit(identifier, localLimit) ? 'limited' : 'allowed';
  }

  try {
    const result = await limiter.limit(identifier);
    return result.success ? 'allowed' : 'limited';
  } catch (error) {
    const original =
      error instanceof Error ? error : new Error('OAuth token rate limit check failed');
    captureUnexpectedError(original, {
      feature: 'oauth',
      operation,
      route: '/api/oauth/token',
    });
    logger.error('OAuth token rate limit check failed');
    return 'unavailable';
  }
}

export function requiresDistributedOAuthTokenRateLimit(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment.VERCEL_ENV === 'production' ||
    environment.VERCEL_TARGET_ENV === 'staging' ||
    environment.MCP_OAUTH_ENVIRONMENT === 'preview'
  );
}

function checkLocalLimit(identifier: string, limit: number): boolean {
  const now = Date.now();
  const recent = (localRequests.get(identifier) ?? []).filter(
    (timestamp) => now - timestamp < LOCAL_WINDOW_MS,
  );
  recent.push(now);
  localRequests.set(identifier, recent);

  if (localRequests.size > 10_000) {
    for (const [key, timestamps] of localRequests) {
      if (timestamps.every((timestamp) => now - timestamp >= LOCAL_WINDOW_MS)) {
        localRequests.delete(key);
      }
    }
  }

  return recent.length > limit;
}
