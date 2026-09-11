import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipLimit = vi.hoisted(() => vi.fn());
const globalLimit = vi.hoisted(() => vi.fn());
const preBodyLimit = vi.hoisted(() => vi.fn());
const refreshLimit = vi.hoisted(() => vi.fn());
const refreshIpLimit = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rate-limit/upstash', () => ({
  oauthTokenIpRateLimit: { limit: ipLimit },
  oauthTokenGlobalRateLimit: { limit: globalLimit },
  oauthTokenPreBodyIpRateLimit: { limit: preBodyLimit },
  oauthTokenRefreshRateLimit: { limit: refreshLimit },
  oauthTokenRefreshIpRateLimit: { limit: refreshIpLimit },
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }));

import {
  checkOAuthTokenGrantRateLimit,
  checkOAuthTokenPreBodyRateLimit,
  requiresDistributedOAuthTokenRateLimit,
} from './token-rate-limit';

const tokenRequest = () =>
  new Request('https://app.dayopt.app/api/oauth/token', {
    headers: { 'x-real-ip': '203.0.113.10' },
  });

/** 既存ケースは authorization_code 相当（IP bucket を通る経路）で維持する。 */
const checkOAuthTokenRateLimit = (request: Request) =>
  checkOAuthTokenGrantRateLimit(request, { type: 'other' });

describe('OAuth token endpoint rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipLimit.mockResolvedValue({ success: true });
    globalLimit.mockResolvedValue({ success: true });
    preBodyLimit.mockResolvedValue({ success: true });
    refreshLimit.mockResolvedValue({ success: true });
    refreshIpLimit.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('checks validated client IP before the global budget', async () => {
    const request = new Request('https://app.dayopt.app/api/oauth/token', {
      headers: { 'x-real-ip': '203.0.113.10' },
    });

    await expect(checkOAuthTokenRateLimit(request)).resolves.toBe('allowed');
    expect(ipLimit).toHaveBeenCalledWith('ip:203.0.113.10');
    expect(globalLimit).toHaveBeenCalledWith('all-clients');
    expect(ipLimit.mock.invocationCallOrder[0]).toBeLessThan(
      globalLimit.mock.invocationCallOrder[0]!,
    );
  });

  it('stops before the global budget when the IP budget is exhausted', async () => {
    ipLimit.mockResolvedValueOnce({ success: false });

    await expect(
      checkOAuthTokenRateLimit(
        new Request('https://app.dayopt.app/api/oauth/token', {
          headers: { 'x-real-ip': '203.0.113.10' },
        }),
      ),
    ).resolves.toBe('limited');
    expect(globalLimit).not.toHaveBeenCalled();
  });

  it('returns limited when the global budget is exhausted', async () => {
    globalLimit.mockResolvedValueOnce({ success: false });

    await expect(
      checkOAuthTokenRateLimit(
        new Request('https://app.dayopt.app/api/oauth/token', {
          headers: { 'x-real-ip': '203.0.113.10' },
        }),
      ),
    ).resolves.toBe('limited');
    expect(ipLimit).toHaveBeenCalledOnce();
    expect(globalLimit).toHaveBeenCalledOnce();
  });

  it('fails closed without logging the client identifier when Redis is unavailable', async () => {
    ipLimit.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      checkOAuthTokenRateLimit(
        new Request('https://app.dayopt.app/api/oauth/token', {
          headers: { 'x-real-ip': '203.0.113.10' },
        }),
      ),
    ).resolves.toBe('unavailable');
    expect(captureUnexpectedError).toHaveBeenCalledOnce();
    expect(loggerError).toHaveBeenCalledWith('OAuth token rate limit check failed');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('203.0.113.10');
  });

  it('fails closed when the global limiter is unavailable', async () => {
    globalLimit.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      checkOAuthTokenRateLimit(
        new Request('https://app.dayopt.app/api/oauth/token', {
          headers: { 'x-real-ip': '203.0.113.10' },
        }),
      ),
    ).resolves.toBe('unavailable');
    expect(captureUnexpectedError).toHaveBeenCalledOnce();
    expect(loggerError).toHaveBeenCalledWith('OAuth token rate limit check failed');
  });

  it('charges the refresh bucket per token instead of the shared client IP', async () => {
    // server-side client（claude.ai / ChatGPT）は全ユーザーの refresh を少数の egress IP
    // から送る。IP bucket に相乗りさせると、接続が増えた時点で互いの上限を食い合って
    // 全員の refresh が 429 になる（#2721 D-01）。
    await expect(
      checkOAuthTokenGrantRateLimit(tokenRequest(), {
        type: 'refresh_token',
        refreshToken: 'dop_rt_alice',
      }),
    ).resolves.toBe('allowed');

    // authorization_code 用の 10/分 は消費しない（共有 egress IP の巻き添えを避ける）。
    expect(ipLimit).not.toHaveBeenCalled();
    expect(refreshLimit).toHaveBeenCalledOnce();
    expect(globalLimit).toHaveBeenCalledWith('all-clients');
  });

  it('refresh でも IP 上限を併用する（token 単位だけだと素通りできる）', async () => {
    // bucket key の材料は検証前の body。毎回別の token を送れば per-token bucket は
    // 無限に作れるので、token 単位だけだと 1 IP から全体上限を飽和させられる。
    await checkOAuthTokenGrantRateLimit(tokenRequest(), {
      type: 'refresh_token',
      refreshToken: 'dop_rt_alice',
    });

    expect(refreshIpLimit).toHaveBeenCalledWith('refresh-ip:203.0.113.10');
    expect(refreshIpLimit.mock.invocationCallOrder[0]).toBeLessThan(
      refreshLimit.mock.invocationCallOrder[0]!,
    );
  });

  it('IP 上限を超えたら token が毎回違っても全体上限へ進ませない', async () => {
    refreshIpLimit.mockResolvedValueOnce({ success: false });

    await expect(
      checkOAuthTokenGrantRateLimit(tokenRequest(), {
        type: 'refresh_token',
        refreshToken: `dop_rt_${Math.random()}`,
      }),
    ).resolves.toBe('limited');
    expect(refreshLimit).not.toHaveBeenCalled();
    expect(globalLimit).not.toHaveBeenCalled();
  });

  it('keeps refresh buckets separate per token and never logs the plaintext', async () => {
    await checkOAuthTokenGrantRateLimit(tokenRequest(), {
      type: 'refresh_token',
      refreshToken: 'dop_rt_alice',
    });
    await checkOAuthTokenGrantRateLimit(tokenRequest(), {
      type: 'refresh_token',
      refreshToken: 'dop_rt_bob',
    });

    const [aliceKey, bobKey] = refreshLimit.mock.calls.map(([identifier]) => identifier as string);
    expect(aliceKey).not.toBe(bobKey);
    // bucket key は hash。平文の refresh token をそのまま載せない。
    expect(aliceKey).not.toContain('dop_rt_alice');
    expect(bobKey).not.toContain('dop_rt_bob');
  });

  it('limits one exhausted refresh token without touching the others', async () => {
    refreshLimit.mockResolvedValueOnce({ success: false });

    await expect(
      checkOAuthTokenGrantRateLimit(tokenRequest(), {
        type: 'refresh_token',
        refreshToken: 'dop_rt_alice',
      }),
    ).resolves.toBe('limited');
    expect(globalLimit).not.toHaveBeenCalled();

    await expect(
      checkOAuthTokenGrantRateLimit(tokenRequest(), {
        type: 'refresh_token',
        refreshToken: 'dop_rt_bob',
      }),
    ).resolves.toBe('allowed');
  });

  it('applies a coarse IP ceiling before the body is read', async () => {
    await expect(checkOAuthTokenPreBodyRateLimit(tokenRequest())).resolves.toBe('allowed');
    expect(preBodyLimit).toHaveBeenCalledOnce();

    preBodyLimit.mockResolvedValueOnce({ success: false });
    await expect(checkOAuthTokenPreBodyRateLimit(tokenRequest())).resolves.toBe('limited');
  });

  it('requires distributed limits for Production and OAuth-enabled Preview', () => {
    expect(requiresDistributedOAuthTokenRateLimit({ VERCEL_ENV: 'production' })).toBe(true);
    expect(
      requiresDistributedOAuthTokenRateLimit({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'staging',
      }),
    ).toBe(true);
    expect(
      requiresDistributedOAuthTokenRateLimit({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
        MCP_OAUTH_ENVIRONMENT: 'preview',
      }),
    ).toBe(true);
    expect(requiresDistributedOAuthTokenRateLimit({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(requiresDistributedOAuthTokenRateLimit({})).toBe(false);
  });
});
