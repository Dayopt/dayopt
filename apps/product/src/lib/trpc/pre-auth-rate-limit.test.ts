/**
 * 認証前の tRPC 境界に上限があること（#2721 の D-06）。
 *
 * `protectedProcedure` の user 単位 300/分 は `ctx.userId` が確定した後にしか働かない。
 * その手前の session 解決は cookie 由来 session があれば毎回 Supabase Auth へ問い合わせる
 * ため、cookie を付けた未認証リクエストで Auth quota と Function 時間を消費できる。
 *
 * cookie 無しは auth-js が外部通信せず短絡するので、その経路には上限を掛けない
 * （掛けても守るものが無く、公開ページからの未認証 procedure を巻き込むだけになる）。
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipLimit: vi.fn(),
  resolveSessionAuthContext: vi.fn(),
  captureUnexpectedError: vi.fn(),
}));

vi.mock('@/lib/rate-limit/upstash', () => ({
  trpcPreAuthIpRateLimit: { limit: mocks.ipLimit },
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError: mocks.captureUnexpectedError }));
vi.mock('@/lib/trpc/session-auth-context', () => ({
  resolveSessionAuthContext: mocks.resolveSessionAuthContext,
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }));

import { createFetchTRPCContext } from './context';

function request(headers: Record<string, string>): Request {
  return new Request('https://app.dayopt.app/api/trpc/plans.list', { method: 'POST', headers });
}

function createContext(headers: Record<string, string>) {
  return createFetchTRPCContext({
    req: request(headers),
    resHeaders: new Headers(),
    info: {} as never,
  } as never);
}

describe('tRPC pre-auth rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipLimit.mockResolvedValue({ success: true });
    mocks.resolveSessionAuthContext.mockResolvedValue({});
  });

  it('cookie を持たないリクエストには上限を掛けない', async () => {
    // session が無ければ auth-js は外部通信せず短絡するので、守る対象が無い。
    await createContext({ 'x-real-ip': '203.0.113.10' });

    expect(mocks.ipLimit).not.toHaveBeenCalled();
  });

  it('cookie 付きのリクエストは IP 単位の上限を通る', async () => {
    await createContext({ 'x-real-ip': '203.0.113.10', cookie: 'sb-access-token=whatever' });

    expect(mocks.ipLimit).toHaveBeenCalledWith('trpc-pre-auth-ip:203.0.113.10');
  });

  it('全 IP 合算の bucket は置かない（少数 IP で全ユーザーを止められるため）', async () => {
    await createContext({ 'x-real-ip': '203.0.113.10', cookie: 'sb-access-token=whatever' });

    // 呼ばれる limiter は IP 単位の 1 本だけ。
    expect(mocks.ipLimit).toHaveBeenCalledOnce();
    const identifiers = mocks.ipLimit.mock.calls.map(([identifier]) => identifier as string);
    expect(identifiers.every((identifier) => identifier.startsWith('trpc-pre-auth-ip:'))).toBe(
      true,
    );
  });

  it('IP の上限を超えたら session を解決せずに拒否する', async () => {
    mocks.ipLimit.mockResolvedValueOnce({ success: false });

    await expect(
      createContext({ 'x-real-ip': '203.0.113.10', cookie: 'sb-access-token=whatever' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // Supabase Auth への問い合わせに到達しないことがこの層の目的。
    expect(mocks.resolveSessionAuthContext).not.toHaveBeenCalled();
  });

  it('limiter が落ちてもアプリ全体を止めない', async () => {
    // ここはアプリの入口なので、Redis 障害で fail-closed にすると全機能が落ちる。
    // 後段の user 単位 limit と protectedProcedure の認証は生きている。
    mocks.ipLimit.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      createContext({ 'x-real-ip': '203.0.113.10', cookie: 'sb-access-token=whatever' }),
    ).resolves.toBeDefined();
    expect(mocks.captureUnexpectedError).toHaveBeenCalledOnce();
    expect(mocks.resolveSessionAuthContext).toHaveBeenCalled();
  });

  it('OAuth bearer は上限を消費する前に拒否する', async () => {
    await expect(
      createContext({ authorization: 'Bearer dop_at_whatever', cookie: 'sb-access-token=x' }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mocks.ipLimit).not.toHaveBeenCalled();
  });
});
