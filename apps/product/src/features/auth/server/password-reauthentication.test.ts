import { createClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithPassword = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const createServiceRoleClient = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const reauthRateLimitMock = vi.hoisted(() => ({ limit: vi.fn() }));
// null に差し替えるテスト用の可変参照。vi.mock のファクトリはホイストされるため
// モジュールレベルの let を経由して後から切り替える
let reauthRateLimit: { limit: ReturnType<typeof vi.fn> } | null = reauthRateLimitMock;

vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn } }));
vi.mock('@/lib/rate-limit/upstash', () => ({
  get reauthRateLimit() {
    return reauthRateLimit;
  },
}));

import {
  enforceReauthRateLimit,
  verifyPasswordWithCaptchaBypass,
} from './password-reauthentication';

const EMAIL = 'user@example.com';
const PASSWORD = 'current-password';
const USER_ID = 'user-123';

beforeEach(() => {
  vi.clearAllMocks();
  reauthRateLimit = reauthRateLimitMock;
  createServiceRoleClient.mockImplementation(() => ({ auth: { signInWithPassword, signOut } }));
  signInWithPassword.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
  reauthRateLimitMock.limit.mockResolvedValue({ success: true });
});

describe('verifyPasswordWithCaptchaBypass', () => {
  it.each(['sb_secret_isolated-test-key', 'eyJ-legacy-isolated-test-key'])(
    'uses the SDK wire contract and revokes only the issued session for %s',
    async (key) => {
      const accessToken = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: USER_ID, exp: 4102444800 })).toString('base64url'),
        'isolated-signature',
      ].join('.');
      const requests: { url: string; headers: Headers; body: string }[] = [];
      const interceptedFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? '') });
        if (url === 'https://isolated.invalid/auth/v1/token?grant_type=password') {
          return Response.json({
            access_token: accessToken,
            refresh_token: 'isolated-refresh-token',
            expires_in: 3600,
            token_type: 'bearer',
            user: {
              id: USER_ID,
              email: EMAIL,
              aud: 'authenticated',
              app_metadata: {},
              user_metadata: {},
            },
          });
        }
        if (url === 'https://isolated.invalid/auth/v1/logout?scope=local') {
          return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected isolated SDK request');
      };
      createServiceRoleClient.mockImplementation(() =>
        createClient('https://isolated.invalid', key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: interceptedFetch },
        }),
      );

      expect(
        await verifyPasswordWithCaptchaBypass({
          email: EMAIL,
          password: PASSWORD,
          context: 'email_change',
        }),
      ).toEqual({ outcome: 'verified' });
      expect(requests).toHaveLength(2);
      expect(requests[0]!.headers.get('apikey')).toBe(key);
      // SDK の互換送信。gateway は apikey と同じ値の Bearer を受け付ける。
      expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${key}`);
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ email: EMAIL, password: PASSWORD });
      expect(requests[1]!.headers.get('apikey')).toBe(key);
      expect(requests[1]!.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
      expect(requests[1]!.url).toBe('https://isolated.invalid/auth/v1/logout?scope=local');
      expect(captureUnexpectedError).not.toHaveBeenCalled();
    },
  );

  it('service-role client の signInWithPassword で検証する（user-scoped client を使うと captcha で必ず失敗する）', async () => {
    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'verified' });
    expect(createServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // scope を省くと既定 'global' でユーザーの全端末が強制ログアウトされる
  it('検証のために発行した session を local scope で破棄する', async () => {
    await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  // auth-js の失敗は throw ではなく戻り値の error で来るので、両方を固定する
  it('session の破棄が error を返しても検証結果は verified のまま返す', async () => {
    signOut.mockResolvedValue({ error: { message: 'revoke failed' } });

    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'verified' });
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('session の破棄が throw しても検証結果は verified のまま返す', async () => {
    signOut.mockRejectedValue(new Error('network'));

    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'verified' });
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('検証に失敗した時は session が発行されないので signOut しない', async () => {
    signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials', status: 400 } });

    await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(signOut).not.toHaveBeenCalled();
  });

  it('client を呼び出しごとに生成する（module スコープに保持すると権限が降格したまま再利用される）', async () => {
    await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });
    await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(createServiceRoleClient).toHaveBeenCalledTimes(2);
  });

  it('invalid_credentials はパスワード誤りとして扱い alert を鳴らさない', async () => {
    signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials', status: 400 } });

    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'invalid_password' });
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // レート制限はサーバー側 egress IP を全ユーザーで共有するため通常運用で起こりうる。
  // ここで alert を鳴らすと canary が狼少年になる
  it.each([
    ['over_request_rate_limit', { code: 'over_request_rate_limit', status: 429 }],
    ['code なしの 429', { status: 429 }],
    ['user_banned', { code: 'user_banned', status: 403 }],
    ['email_not_confirmed', { code: 'email_not_confirmed', status: 400 }],
  ])('%s は削除を通さないが alert は鳴らさない', async (_label, error) => {
    signInWithPassword.mockResolvedValue({ error });

    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // 迂回が壊れた時のシグナル。captcha_failed は lib/sentry の EXPECTED_AUTH_ERROR_CODES に
  // 含まれるため observeAuthOperation 経由では報告されない。直接 capture する必要がある
  it.each([
    ['captcha_failed（迂回が効かなくなった）', { code: 'captcha_failed', status: 400 }],
    ['bad_jwt（service role key が失効・誤設定）', { code: 'bad_jwt', status: 401 }],
    ['未知の code', { code: 'something_new', status: 400 }],
    ['code を持たない失敗', { message: 'boom' }],
  ])('%s は構成故障として alert を鳴らす', async (_label, error) => {
    signInWithPassword.mockResolvedValue({ error });

    const result = await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'account_deletion',
    });

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(captureUnexpectedError).toHaveBeenCalledTimes(1);

    const [reported, context] = captureUnexpectedError.mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).cause).toBe(error);
    expect(context).toMatchObject({
      feature: 'account_deletion',
      operation: 'account_deletion_reauthenticate',
      source: 'captcha_bypass',
    });
  });

  // email 変更側の構成故障が削除フローの alert に混入しないことを固定する
  it('context: email_change の構成故障は email_change の feature/operation で報告する', async () => {
    signInWithPassword.mockResolvedValue({ error: { code: 'bad_jwt', status: 401 } });

    await verifyPasswordWithCaptchaBypass({
      email: EMAIL,
      password: PASSWORD,
      context: 'email_change',
    });

    const [, context] = captureUnexpectedError.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      feature: 'email_change',
      operation: 'email_change_reauthenticate',
      source: 'captcha_bypass',
    });
  });
});

describe('enforceReauthRateLimit', () => {
  it('Upstash 未設定（reauthRateLimit が null）なら素通りする', async () => {
    reauthRateLimit = null;

    await expect(enforceReauthRateLimit(USER_ID, 'account_deletion')).resolves.toBeUndefined();
    expect(reauthRateLimitMock.limit).not.toHaveBeenCalled();
  });

  it('制限内なら通過し、identifier は `${context}:${userId}` になる', async () => {
    await enforceReauthRateLimit(USER_ID, 'email_change');

    expect(reauthRateLimitMock.limit).toHaveBeenCalledWith(`email_change:${USER_ID}`);
  });

  // 同一 userId でも context が違えば別 bucket を消費する。これが無いと、email 変更で
  // パスワードを打ち間違えたユーザーが無関係の account 削除まで巻き添えで止まる
  it('account_deletion と email_change で identifier（bucket）が分離される', async () => {
    await enforceReauthRateLimit(USER_ID, 'account_deletion');
    await enforceReauthRateLimit(USER_ID, 'email_change');

    expect(reauthRateLimitMock.limit).toHaveBeenNthCalledWith(1, `account_deletion:${USER_ID}`);
    expect(reauthRateLimitMock.limit).toHaveBeenNthCalledWith(2, `email_change:${USER_ID}`);
  });

  it('制限超過なら TOO_MANY_REQUESTS の TRPCError を throw する', async () => {
    reauthRateLimitMock.limit.mockResolvedValue({ success: false });

    const rejection = expect(enforceReauthRateLimit(USER_ID, 'account_deletion')).rejects;
    await rejection.toBeInstanceOf(TRPCError);
    await rejection.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('Upstash 障害（limit が throw）なら SERVICE_UNAVAILABLE の TRPCError を throw する', async () => {
    reauthRateLimitMock.limit.mockRejectedValue(new Error('upstash timeout'));

    const rejection = expect(enforceReauthRateLimit(USER_ID, 'account_deletion')).rejects;
    await rejection.toBeInstanceOf(TRPCError);
    await rejection.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
