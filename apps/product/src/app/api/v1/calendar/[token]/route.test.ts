import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock } from '@/lib/test/trpc-test-helpers';

const createServiceRoleClient = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
const ipLimit = vi.hoisted(() => vi.fn());
const globalLimit = vi.hoisted(() => vi.fn());

vi.mock('@/features/timeblock', () => ({
  plansToICal: vi.fn(() => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
}));
vi.mock('@/lib/rate-limit/upstash', () => ({
  icalFeedRateLimit: { limit: rateLimit },
  icalFeedIpRateLimit: { limit: ipLimit },
  icalFeedGlobalRateLimit: { limit: globalLimit },
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
}));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));

import { GET } from './route';

const TOKEN = '00000000-0000-4000-8000-000000000001';

function request(ip = '203.0.113.10', token = TOKEN) {
  return new NextRequest(`https://app.dayopt.com/api/v1/calendar/${token}.ics`, {
    headers: { 'x-real-ip': ip },
  });
}

function mockTokenLookup(userId: string | null = 'user-1') {
  createServiceRoleClient
    .mockReturnValueOnce({
      from: vi.fn(() => createChainableMock(userId ? { user_id: userId } : null)),
    })
    .mockReturnValueOnce({ from: vi.fn(() => createChainableMock([])) });
}

function context(token = TOKEN) {
  return { params: Promise.resolve({ token: `${token}.ics` }) };
}

describe('iCal feed route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    ipLimit.mockResolvedValue({ success: true });
    globalLimit.mockResolvedValue({ success: true });
    captureUnexpectedDatabaseError.mockImplementation((error: unknown) =>
      error instanceof Error ? error : new Error('Unexpected database failure', { cause: error }),
    );
  });

  it('IP集約上限をtoken解決より前に評価し、到達をSentryへcaptureする(サンプリング付き)', async () => {
    ipLimit.mockResolvedValue({ success: false });

    const response = await GET(request(), context());

    expect(response.status).toBe(429);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(globalLimit).not.toHaveBeenCalled();
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'check_ip_rate_limit', source: 'upstash' }),
    );

    // sampling windowはmodule scopeで永続するため、同一テスト内で連続到達を再現する。
    await GET(request(), context());
    await GET(request(), context());

    expect(captureUnexpectedError).toHaveBeenCalledTimes(1);
  });

  it('global集約上限超過時もtoken解決より前で止める', async () => {
    globalLimit.mockResolvedValueOnce({ success: false });

    const response = await GET(request(), context());

    expect(response.status).toBe(429);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(ipLimit).toHaveBeenCalledOnce();
  });

  it('IP→globalの順で評価する', async () => {
    mockTokenLookup();

    await GET(request(), context());

    expect(ipLimit.mock.invocationCallOrder[0]).toBeLessThan(
      globalLimit.mock.invocationCallOrder[0]!,
    );
  });

  it('形式不正なtokenは集約rate limitより前に400で弾き、Redisを消費しない', async () => {
    const response = await GET(request(), { params: Promise.resolve({ token: 'not-a-uuid' }) });

    expect(response.status).toBe(400);
    expect(ipLimit).not.toHaveBeenCalled();
    expect(globalLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['2001:db8::1', '2001:db8::2', 'ip6:2001:db8:0:0'],
    ['fe80::abcd:1234:5678:9abc', 'fe80::dead:beef:0:1', 'ip6:fe80:0:0:0'],
  ])('同一/64内の異なるIPv6アドレス(%s, %s)は同じbucketを共有する(%s)', async (ipA, ipB) => {
    mockTokenLookup();
    await GET(request(ipA), context());
    const identifierA = ipLimit.mock.calls[0]?.[0];

    ipLimit.mockClear();
    globalLimit.mockClear();
    mockTokenLookup();
    await GET(request(ipB), context());
    const identifierB = ipLimit.mock.calls[0]?.[0];

    expect(identifierA).toBe(identifierB);
  });

  it('IPv4アドレスはそのままbucket keyになる(IPv6のような丸めをしない)', async () => {
    mockTokenLookup();

    await GET(request('203.0.113.10'), context());

    expect(ipLimit).toHaveBeenCalledWith('ip:203.0.113.10');
  });

  it('集約limiterの例外はfail closed(503)にし、token解決を行わず、captureはサンプリングして連続失敗でquotaを焼かない', async () => {
    const backendError = new Error('redis unavailable');
    ipLimit.mockRejectedValue(backendError);

    const response = await GET(request(), context());

    expect(response.status).toBe(503);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'check_ip_rate_limit', source: 'upstash' }),
    );

    // sampling windowはmodule scopeで永続するため、同一テスト内で連続失敗を再現する。
    await GET(request(), context());
    await GET(request(), context());

    expect(captureUnexpectedError).toHaveBeenCalledTimes(1);
  });

  it('存在しないtokenは401で、Issue化しない', async () => {
    createServiceRoleClient.mockReturnValue({ from: vi.fn(() => createChainableMock(null)) });

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(captureUnexpectedDatabaseError).not.toHaveBeenCalled();
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // token rotate（regenerateICalToken、settings-service.ts）の temporal contract（#2081）。
  // クロスレビュー指摘（risk / behavior 一致、指揮台採用）: 旧実装は「mock が null を返す」
  // ことで 401 を成立させていただけで、regenerateICalToken を一度も呼んでいなかった —
  // rotate 自体が壊れても（UPDATE を撃たない等）このテストは緑のままだった。
  //
  // token → user_id の 1 行ストアを状態として持ち、SettingsService.regenerateICalToken を
  // 実際に呼び出して token を書き換える。route 側の createServiceRoleClient はこの同じ
  // 状態を参照するため、(1) rotate 前は旧 token で 200 (2) rotate 実行 (3) rotate 後は
  // 旧 token 401 / 新 token 200、の 3 点が「rotate の副作用として」成立することを固定する。
  //
  // 410（issue #2081 の当初検証基準）ではなく 401 を維持する設計判断は #2081 の plan
  // コメント参照 — revoked token 履歴を持たない現在の設計では「一度も存在しなかった
  // token」と「rotate 済みの旧 token」を区別できない。
  it('rotate前は旧tokenが200、rotate後は旧tokenが401・新tokenが200になる', async () => {
    const USER_ID = 'user-1';
    const state = { userId: USER_ID, token: '00000000-0000-4000-8000-0000000000aa' };
    const OLD_TOKEN = state.token;

    // route 側（service-role client）: user_settings.select().eq('ical_feed_token', token)
    // が state.token と一致する時だけ user_id を返す。plans は空配列で固定。
    createServiceRoleClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'plans') return createChainableMock([]);
        const chain: {
          select: ReturnType<typeof vi.fn>;
          eq: ReturnType<typeof vi.fn>;
          maybeSingle: ReturnType<typeof vi.fn>;
          matched: boolean;
        } = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn(),
          matched: false,
        };
        chain.select.mockReturnValue(chain);
        chain.eq.mockImplementation((_column: string, value: string) => {
          chain.matched = value === state.token;
          return chain;
        });
        chain.maybeSingle.mockImplementation(() =>
          Promise.resolve({
            data: chain.matched ? { user_id: state.userId } : null,
            error: null,
          }),
        );
        return chain;
      }),
    });

    // (1) rotate 前: 旧 token はまだ有効。
    const beforeResponse = await GET(request(undefined, OLD_TOKEN), context(OLD_TOKEN));
    expect(beforeResponse.status).toBe(200);

    // (2) rotate 実行: settings-service 側（別 supabase client、同じ state を共有）。
    // upsert は直接 await される（select/single を挟まない）ので then 可能な Promise を返す。
    // update は渡された新 token を state.token へ即時反映し、後続の eq/select/single が
    // その値を返す。
    const settingsFrom = vi.fn(() => {
      const chain: {
        upsert: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        select: ReturnType<typeof vi.fn>;
        single: ReturnType<typeof vi.fn>;
      } = {
        upsert: vi.fn(() => Promise.resolve({ error: null })),
        update: vi.fn(),
        eq: vi.fn(),
        select: vi.fn(),
        single: vi.fn(),
      };
      chain.update.mockImplementation((patch: { ical_feed_token: string }) => {
        state.token = patch.ical_feed_token;
        return chain;
      });
      chain.eq.mockReturnValue(chain);
      chain.select.mockReturnValue(chain);
      chain.single.mockImplementation(() =>
        Promise.resolve({ data: { ical_feed_token: state.token }, error: null }),
      );
      return chain;
    });
    const { SettingsService } = await import('@/features/settings/server/settings-service');
    const settingsService = new SettingsService({ from: settingsFrom } as never);
    const { token: newToken } = await settingsService.regenerateICalToken(USER_ID);
    expect(newToken).not.toBe(OLD_TOKEN);
    expect(state.token).toBe(newToken);

    // (3) rotate 後: 旧 token は失効、新 token が有効。
    const oldResponse = await GET(request(undefined, OLD_TOKEN), context(OLD_TOKEN));
    expect(oldResponse.status).toBe(401);

    const newResponse = await GET(request(undefined, newToken), context(newToken));
    expect(newResponse.status).toBe(200);
  });

  it('token lookupのDB障害を500としてcaptureし、401へ丸めない', async () => {
    const dbError = { message: 'database unavailable', code: 'PGRST000' };
    createServiceRoleClient.mockReturnValue({
      from: vi.fn(() => createChainableMock(null, dbError)),
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledWith(dbError, {
      feature: 'calendar_feed',
      operation: 'resolve_feed_token',
      route: '/api/v1/calendar/[token]',
    });
    expect(captureUnexpectedError).toHaveBeenCalledOnce();
  });

  it('plan fetchのDB障害を空calendar 200へ変換しない', async () => {
    const tokenQuery = createChainableMock({ user_id: 'user-1' });
    const dbError = { message: 'database unavailable', code: 'PGRST000' };
    const plansQuery = createChainableMock(null, dbError);
    createServiceRoleClient
      .mockReturnValueOnce({ from: vi.fn(() => tokenQuery) })
      .mockReturnValueOnce({ from: vi.fn(() => plansQuery) });

    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledWith(dbError, {
      feature: 'calendar_feed',
      operation: 'fetch_feed_plans',
      route: '/api/v1/calendar/[token]',
    });
  });

  it('Upstash障害は一度captureしてin-memoryへfallbackする', async () => {
    const networkError = new TypeError('fetch failed');
    rateLimit.mockRejectedValue(networkError);
    const tokenQuery = createChainableMock({ user_id: 'user-1' });
    const plansQuery = createChainableMock([]);
    createServiceRoleClient
      .mockReturnValueOnce({ from: vi.fn(() => tokenQuery) })
      .mockReturnValueOnce({ from: vi.fn(() => plansQuery) });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(captureUnexpectedError).toHaveBeenCalledWith(networkError, {
      feature: 'calendar_feed',
      operation: 'check_rate_limit',
      route: '/api/v1/calendar/[token]',
      source: 'upstash',
    });
  });
});

describe('iCal feed route (aggregate limiter未設定)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@/lib/rate-limit/upstash');
    vi.resetModules();
  });

  it.each([
    ['production', undefined, undefined, 503],
    ['preview', undefined, undefined, 200],
    ['preview', 'integration', undefined, 503],
    ['preview', undefined, 'integration', 503],
  ])(
    'VERCEL_ENV=%s / DAYOPT_ENVIRONMENT=%s / MCP_OAUTH_ENVIRONMENT=%s の時、limiter未設定はstatus %iになる',
    async (vercelEnv, dayoptEnvironment, mcpOAuthEnvironment, expectedStatus) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv);
      if (dayoptEnvironment) {
        vi.stubEnv('DAYOPT_ENVIRONMENT', dayoptEnvironment);
        vi.stubEnv('NEXT_PUBLIC_DAYOPT_ENVIRONMENT', dayoptEnvironment);
      }
      if (mcpOAuthEnvironment) vi.stubEnv('MCP_OAUTH_ENVIRONMENT', mcpOAuthEnvironment);
      vi.doMock('@/lib/rate-limit/upstash', () => ({
        icalFeedRateLimit: { limit: rateLimit },
        icalFeedIpRateLimit: null,
        icalFeedGlobalRateLimit: null,
      }));
      vi.resetModules();
      const { GET: freshGet } = await import('./route');
      mockTokenLookup();
      rateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() });

      const response = await freshGet(request(), context());

      expect(response.status).toBe(expectedStatus);
    },
  );
});
