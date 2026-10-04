import { beforeEach, describe, expect, it, vi } from 'vitest';

const preAuthLimit = vi.hoisted(() => vi.fn());
const userLimit = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rate-limit/upstash', () => ({
  mcpPreAuthRateLimit: { limit: preAuthLimit },
  mcpUserRateLimit: { limit: userLimit },
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }));

import {
  checkMcpPreAuthRateLimit,
  checkMcpUserRateLimit,
  requiresDistributedMcpRateLimit,
} from './request-rate-limit';

describe('checkMcpUserRateLimit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('limits pre-auth traffic by validated client IP before token lookup', async () => {
    preAuthLimit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const request = new Request('https://mcp.dayopt.app/mcp', {
      headers: { 'x-real-ip': '203.0.113.10' },
    });

    await expect(checkMcpPreAuthRateLimit(request)).resolves.toBe('allowed');
    await expect(checkMcpPreAuthRateLimit(request)).resolves.toBe('limited');
    expect(preAuthLimit).toHaveBeenNthCalledWith(1, 'ip:203.0.113.10');
    expect(preAuthLimit).toHaveBeenNthCalledWith(2, 'ip:203.0.113.10');
  });

  it('returns allowed or limited from the dedicated user limiter', async () => {
    userLimit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });

    await expect(checkMcpUserRateLimit('user-1')).resolves.toBe('allowed');
    await expect(checkMcpUserRateLimit('user-1')).resolves.toBe('limited');
    expect(userLimit).toHaveBeenNthCalledWith(1, 'user:user-1');
    expect(userLimit).toHaveBeenNthCalledWith(2, 'user:user-1');
  });

  it('fails closed as unavailable without logging the user identifier', async () => {
    userLimit.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(checkMcpUserRateLimit('private-user-id')).resolves.toBe('unavailable');
    expect(captureUnexpectedError).toHaveBeenCalledOnce();
    expect(loggerError).toHaveBeenCalledWith('MCP rate limit check failed');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('private-user-id');
  });

  it('requires a distributed limiter for Production, staging, and OAuth-enabled Preview', () => {
    expect(requiresDistributedMcpRateLimit({ VERCEL_ENV: 'production' })).toBe(true);
    expect(
      requiresDistributedMcpRateLimit({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'staging',
      }),
    ).toBe(true);
    expect(
      requiresDistributedMcpRateLimit({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        MCP_OAUTH_ENVIRONMENT: 'preview',
      }),
    ).toBe(true);
    expect(requiresDistributedMcpRateLimit({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(
      requiresDistributedMcpRateLimit({ VERCEL_ENV: 'preview', DAYOPT_ENVIRONMENT: 'integration' }),
    ).toBe(true);
    expect(
      requiresDistributedMcpRateLimit({
        VERCEL_ENV: 'preview',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
      }),
    ).toBe(true);
    expect(
      requiresDistributedMcpRateLimit({
        VERCEL_ENV: 'preview',
        MCP_OAUTH_ENVIRONMENT: 'integration',
      }),
    ).toBe(true);
    expect(
      requiresDistributedMcpRateLimit({
        VERCEL_ENV: 'preview',
        DAYOPT_ENVIRONMENT: 'preview',
      }),
    ).toBe(false);
    expect(requiresDistributedMcpRateLimit({})).toBe(false);
  });
});
