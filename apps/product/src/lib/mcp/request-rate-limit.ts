import 'server-only';

import { logger } from '@/lib/logger';
import { mcpPreAuthRateLimit, mcpUserRateLimit } from '@/lib/rate-limit/upstash';
import { extractClientIp } from '@/lib/security/ip-validation';
import { captureUnexpectedError } from '@/lib/sentry';

const LOCAL_PRE_AUTH_LIMIT = 1_200;
const LOCAL_USER_LIMIT = 120;
const LOCAL_WINDOW_MS = 60_000;
const localRequests = new Map<string, number[]>();

export type McpRateLimitState = 'allowed' | 'limited' | 'unavailable';

export async function checkMcpPreAuthRateLimit(request: Request): Promise<McpRateLimitState> {
  const ip = extractClientIp(request.headers.get('x-real-ip'));
  return checkMcpRateLimit(
    mcpPreAuthRateLimit,
    `ip:${ip}`,
    LOCAL_PRE_AUTH_LIMIT,
    'check_pre_auth_rate_limit',
  );
}

export async function checkMcpUserRateLimit(userId: string): Promise<McpRateLimitState> {
  return checkMcpRateLimit(
    mcpUserRateLimit,
    `user:${userId}`,
    LOCAL_USER_LIMIT,
    'check_user_rate_limit',
  );
}

interface McpRateLimiter {
  limit(identifier: string): Promise<{ success: boolean }>;
}

async function checkMcpRateLimit(
  limiter: McpRateLimiter | null,
  identifier: string,
  localLimit: number,
  operation: string,
): Promise<McpRateLimitState> {
  if (!limiter) {
    if (requiresDistributedMcpRateLimit(process.env)) {
      logger.error('MCP rate limit configuration is unavailable');
      return 'unavailable';
    }
    return checkLocalLimit(identifier, localLimit) ? 'limited' : 'allowed';
  }

  try {
    const result = await limiter.limit(identifier);
    return result.success ? 'allowed' : 'limited';
  } catch (error) {
    const original = error instanceof Error ? error : new Error('MCP rate limit check failed');
    captureUnexpectedError(original, {
      feature: 'mcp',
      operation,
    });
    logger.error('MCP rate limit check failed');
    return 'unavailable';
  }
}

export function requiresDistributedMcpRateLimit(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment.VERCEL_ENV === 'production' ||
    environment.VERCEL_TARGET_ENV === 'staging' ||
    environment.MCP_OAUTH_ENVIRONMENT === 'preview' ||
    environment.DAYOPT_ENVIRONMENT === 'integration' ||
    environment.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration' ||
    environment.MCP_OAUTH_ENVIRONMENT === 'integration'
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
