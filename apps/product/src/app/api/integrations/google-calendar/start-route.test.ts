import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUser = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
const checkEntitlementForUser = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const getReconnectTarget = vi.hoisted(() => vi.fn());
const beginCalendarOAuthAttempt = vi.hoisted(() => vi.fn());
const resolveMfaAssurance = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({
  GOOGLE_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
  CALENDAR_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
  GOOGLE_CALENDAR_REDIRECT_URIS:
    'https://app.dayopt.app/api/integrations/google-calendar/callback,http://localhost:3000/api/integrations/google-calendar/callback',
}));

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/rate-limit/upstash', () => ({
  calendarConnectRateLimit: { limit: rateLimit },
}));
vi.mock('@/lib/billing/enforcement', () => ({ checkEntitlementForUser }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/features/external-calendar/server/connection-service', () => ({
  beginCalendarOAuthAttempt,
  getReconnectTarget,
}));
vi.mock('@/lib/trpc/session-auth-context', () => ({ resolveMfaAssurance }));

import { GET } from './start/route';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function request(url = 'https://app.dayopt.app/api/integrations/google-calendar/start') {
  return new NextRequest(url);
}

describe('google calendar start route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(envMock, {
      GOOGLE_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
      CALENDAR_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
      GOOGLE_CALENDAR_REDIRECT_URIS:
        'https://app.dayopt.app/api/integrations/google-calendar/callback,http://localhost:3000/api/integrations/google-calendar/callback',
    });
    getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    createClient.mockResolvedValue({ auth: { getUser }, from });
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal1' });
    rateLimit.mockResolvedValue({ success: true });
    checkEntitlementForUser.mockResolvedValue('allowed');
    beginCalendarOAuthAttempt.mockResolvedValue('00000000-0000-4000-8000-0000000000a2');
    getReconnectTarget.mockResolvedValue({
      id: '00000000-0000-4000-8000-0000000000c1',
      providerAccountId: 'google-sub-123',
      providerAccountEmail: 'owner@example.com',
    });
  });

  it('env が未設定なら 503 で止まり Google へ飛ばさない', async () => {
    envMock.GOOGLE_CALENDAR_CLIENT_ID = '';

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('暗号鍵の長さが不正なら Google へ送る前に 503 で止める', async () => {
    // 空でないが 32 バイトに decode できない鍵（15 バイト）。同意まで取ってから
    // 保存に失敗するのを防ぐ。base64 リテラルを直書きすると gitleaks の
    // generic-api-key に引っかかるため式で組み立てる。
    envMock.CALENDAR_TOKEN_ENCRYPTION_KEY = 'A'.repeat(20);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('未認証はログインへ redirect する', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login');
  });

  it('MFA登録済みでaal2未検証のセッションは mfa-verify へ redirect し、認可URLへは進まない', async () => {
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' });

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/mfa-verify');
    expect(checkEntitlementForUser).not.toHaveBeenCalled();
  });

  // proxy.tsのgetLocalizedPath(as-needed prefix)に揃える。default localeは
  // プレフィックス無し、それ以外は付く(proxy.test.ts側は/ja/auth/mfa-verifyを固定済み)
  it('mfa-verify redirectはdefault locale(en)ではlocale prefixを付けない', async () => {
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' });

    const response = await GET(request());

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/mfa-verify');
  });

  it('mfa-verify redirectは非default localeでlocale prefixを付ける', async () => {
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' });

    const response = await GET(
      request('https://app.dayopt.app/api/integrations/google-calendar/start?locale=ja'),
    );

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/ja/auth/mfa-verify');
  });

  // lookupFailed は自分のcookie由来のAAL claimから攻撃者が繰り返し到達できるため、
  // captureすると無制限にSentry quotaを焼ける増幅経路になる。captureしないことを固定する。
  it('MFA assurance lookup 失敗は 500 で止め、Sentryへcaptureせず、認可URLへも進まない', async () => {
    resolveMfaAssurance.mockResolvedValue({
      currentLevel: null,
      nextLevel: null,
      lookupFailed: true,
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).not.toHaveBeenCalled();
    expect(checkEntitlementForUser).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('aal2セッションでは通常どおり認可URLへ進む', async () => {
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' });

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').origin).toBe(
      'https://accounts.google.com',
    );
  });

  it('allowlist に無い host では 400 で接続を始めない', async () => {
    const response = await GET(
      request(
        'https://product-git-preview-dayopt.vercel.app/api/integrations/google-calendar/start',
      ),
    );

    expect(response.status).toBe(400);
  });

  it('Google の認可 URL へ redirect し、PKCE と state cookie を設定する', async () => {
    const response = await GET(request());

    expect(response.status).toBe(307);

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    // openid が無いと Google は id_token を返さず、接続の同定に使う sub が取れない。
    // Calendar scope は narrow pair（#1982、GCP 審査の最小権限要件）
    expect(location.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly',
    );
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent select_account');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    // allowlist の文字列がそのまま渡り、request から組み立て直されていない
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://app.dayopt.app/api/integrations/google-calendar/callback',
    );

    const cookie = response.cookies.get('__Host-dayopt-calendar-connect');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.maxAge).toBe(600);

    const flowState = JSON.parse(decodeURIComponent(cookie?.value ?? '{}'));
    expect(flowState.userId).toBe(USER_ID);
    expect(flowState.attemptId).toBe('00000000-0000-4000-8000-0000000000a2');
    expect(beginCalendarOAuthAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
    expect(flowState.state).toBe(location.searchParams.get('state'));
    // verifier は cookie にだけ入り、URL には出ない
    expect(flowState.verifier).toBeTruthy();
    expect(location.searchParams.get('code_verifier')).toBeNull();
  });

  it('server-side OAuth attempt を保存できなければ Google へ redirect しない', async () => {
    beginCalendarOAuthAttempt.mockRejectedValueOnce(new Error('attempt unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    expect(response.cookies.get('__Host-dayopt-calendar-connect')).toBeUndefined();
  });

  it('本人の reauth_required 接続だけを再接続 cookie に保存する', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    const response = await GET(
      request(
        `https://app.dayopt.app/api/integrations/google-calendar/start?locale=ja&reconnectConnectionId=${connectionId}`,
      ),
    );

    expect(getReconnectTarget).toHaveBeenCalledWith(USER_ID, connectionId);
    const cookie = response.cookies.get('__Host-dayopt-calendar-connect');
    const flowState = JSON.parse(decodeURIComponent(cookie?.value ?? '{}'));
    expect(flowState).toMatchObject({ locale: 'ja', reconnectConnectionId: connectionId });
  });

  // 違うアカウントを選ぶと callback の sub 一致検査で弾かれてやり直しになる（Step 7）
  it('再接続では対象アカウントを login_hint で示唆する', async () => {
    const response = await GET(
      request(
        'https://app.dayopt.app/api/integrations/google-calendar/start?reconnectConnectionId=00000000-0000-4000-8000-0000000000c1',
      ),
    );

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('login_hint')).toBe('owner@example.com');
    // hint はあくまで示唆。毎回アカウントを選ばせる prompt は外さない。
    expect(location.searchParams.get('prompt')).toBe('consent select_account');
  });

  it('email 未記録の再接続でも login_hint 無しで続行する', async () => {
    getReconnectTarget.mockResolvedValue({
      id: '00000000-0000-4000-8000-0000000000c1',
      providerAccountId: 'google-sub-123',
      providerAccountEmail: null,
    });

    const response = await GET(
      request(
        'https://app.dayopt.app/api/integrations/google-calendar/start?reconnectConnectionId=00000000-0000-4000-8000-0000000000c1',
      ),
    );

    expect(response.status).toBe(307);
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('login_hint'),
    ).toBeNull();
  });

  it('新規接続では login_hint を付けない', async () => {
    const response = await GET(request());

    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('login_hint'),
    ).toBeNull();
  });

  it.each([
    ['not-a-uuid', false],
    ['00000000-0000-4000-8000-0000000000c1', true],
  ])('不正または存在しない再接続対象 %s は 400', async (connectionId, validUuid) => {
    if (validUuid) getReconnectTarget.mockResolvedValue(null);

    const response = await GET(
      request(
        `https://app.dayopt.app/api/integrations/google-calendar/start?reconnectConnectionId=${connectionId}`,
      ),
    );

    expect(response.status).toBe(400);
  });

  it('http の localhost では __Host- prefix を落とす', async () => {
    const response = await GET(
      request('http://localhost:3000/api/integrations/google-calendar/start'),
    );

    expect(response.cookies.get('dayopt-calendar-connect')).toBeDefined();
    expect(response.cookies.get('__Host-dayopt-calendar-connect')).toBeUndefined();
  });

  it('rate limit 超過は 429', async () => {
    rateLimit.mockResolvedValue({ success: false });

    const response = await GET(request());

    expect(response.status).toBe(429);
  });

  it('rate limit backend が落ちても接続開始は続行する', async () => {
    rateLimit.mockRejectedValue(new Error('redis unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(captureUnexpectedError).toHaveBeenCalled();
  });

  it('Pro でないユーザーは 403', async () => {
    checkEntitlementForUser.mockResolvedValue('denied');

    const response = await GET(request());

    expect(response.status).toBe(403);
  });

  it('subscription の参照に失敗したら 500', async () => {
    checkEntitlementForUser.mockResolvedValue('lookup_failed');

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).toHaveBeenCalled();
  });
});
