import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarConnectionSaveError } from '@/features/external-calendar/server/connection-service';

const getUser = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const saveConnection = vi.hoisted(() => vi.fn());
const reconnectConnection = vi.hoisted(() => vi.fn());
const claimCalendarOAuthAttempt = vi.hoisted(() => vi.fn());
const getReconnectTarget = vi.hoisted(() => vi.fn());
const revokeOrphanedGrant = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const checkEntitlementForUser = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
const isWriteFenceEnabled = vi.hoisted(() => vi.fn());
const resolveMfaAssurance = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({
  GOOGLE_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
  CALENDAR_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
  GOOGLE_CALENDAR_REDIRECT_URIS: 'https://app.dayopt.app/api/integrations/google-calendar/callback',
}));

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/billing/enforcement', () => ({ checkEntitlementForUser }));
vi.mock('@/lib/rate-limit/upstash', () => ({ calendarConnectRateLimit: { limit: rateLimit } }));
vi.mock('@/features/external-calendar/server/connection-service', async (importOriginal) => {
  // CALENDAR_CONNECTION_DB_TIMEOUT_MS は実値を使う（route.ts が予算を導出する
  // 導出に使う、#1990）。手書きで複製すると本体側の値が変わった時にテストが追従しない
  // （risk-reviewer 指摘、PR #2075）。
  const actual =
    await importOriginal<typeof import('@/features/external-calendar/server/connection-service')>();
  return {
    ...actual,
    saveConnection,
    reconnectConnection,
    claimCalendarOAuthAttempt,
    getReconnectTarget,
    revokeOrphanedGrant,
  };
});
vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient: vi.fn(() => ({})) }));
vi.mock('@/lib/trpc/session-auth-context', () => ({ resolveMfaAssurance }));

import { GET } from './callback/route';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const STATE = 'state-value';
/** 旧・広い scope。既存接続の後方互換を確認する test でだけ明示的に使う（#1982）。 */
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** narrow pair。新規の認可リクエストはこの 2 本を要求する（#1982）。 */
const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
/** `tokenResponse()` の既定 scope。production で実際に走る主経路（#1982）。 */
const NARROW_PAIR_SCOPE = `${CALENDAR_LIST_SCOPE} ${CALENDAR_EVENTS_SCOPE}`;

function idToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: 'client-id.apps.googleusercontent.com',
    sub: 'google-sub-123',
    email: 'user@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: NARROW_PAIR_SCOPE,
    id_token: idToken(),
    ...overrides,
  };
}

function request(options: { state?: string | null; code?: string | null; error?: string } = {}) {
  const url = new URL('https://app.dayopt.app/api/integrations/google-calendar/callback');
  if (options.error) url.searchParams.set('error', options.error);
  if (options.state !== null) url.searchParams.set('state', options.state ?? STATE);
  if (options.code !== null) url.searchParams.set('code', options.code ?? 'auth-code');

  const nextRequest = new NextRequest(url);
  return nextRequest;
}

function withCookie(
  nextRequest: NextRequest,
  overrides: Record<string, unknown> = {},
): NextRequest {
  nextRequest.cookies.set(
    '__Host-dayopt-calendar-connect',
    JSON.stringify({
      state: STATE,
      verifier: 'code-verifier',
      attemptId: '00000000-0000-4000-8000-0000000000a2',
      locale: 'ja',
      userId: USER_ID,
      ...overrides,
    }),
  );
  return nextRequest;
}

function reasonOf(response: Response): string | null {
  return new URL(response.headers.get('location') ?? '').searchParams.get('reason');
}

describe('google calendar callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    createClient.mockResolvedValue({ auth: { getUser } });
    saveConnection.mockResolvedValue('saved');
    reconnectConnection.mockResolvedValue('saved');
    claimCalendarOAuthAttempt.mockResolvedValue(undefined);
    getReconnectTarget.mockResolvedValue({
      id: '00000000-0000-4000-8000-0000000000c1',
      providerAccountId: 'google-sub-123',
    });
    revokeOrphanedGrant.mockResolvedValue(undefined);
    checkEntitlementForUser.mockResolvedValue('allowed');
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal1' });
    rateLimit.mockResolvedValue({ success: true });
    isWriteFenceEnabled.mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(tokenResponse()), { status: 200 }))),
    );
  });

  it('one-time OAuth attempt を code 交換より先に claim する', async () => {
    const order: string[] = [];
    claimCalendarOAuthAttempt.mockImplementation(async () => {
      order.push('claim');
    });
    const fetchMock = vi.fn(async () => {
      order.push('exchange');
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(claimCalendarOAuthAttempt).toHaveBeenCalledWith({
      attemptId: '00000000-0000-4000-8000-0000000000a2',
      userId: USER_ID,
      state: STATE,
      verifier: 'code-verifier',
    });
    expect(order).toEqual(['claim', 'exchange']);
  });

  it('OAuth attempt を claim できなければ Google の code を消費しない', async () => {
    claimCalendarOAuthAttempt.mockRejectedValueOnce(new Error('attempt unavailable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('connection_failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('env が未設定なら 503', async () => {
    envMock.GOOGLE_CALENDAR_CLIENT_ID = '';

    const response = await GET(withCookie(request()));

    expect(response.status).toBe(503);
    envMock.GOOGLE_CALENDAR_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  });

  it('未認証はログインへ redirect し、接続を保存しない', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await GET(withCookie(request()));

    expect(response.headers.get('location')).toContain('/auth/login');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  // start と同じ理由。cookie が自作できる以上、start を踏まずに callback へ直接来られる
  it('MFA登録済みでaal2未検証のセッションは token 交換に到達しない', async () => {
    resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' });

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('mfa_verification_required');
    expect(fetch).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  // lookupFailed は自分のcookie由来のAAL claimから攻撃者が繰り返し到達できるため、
  // captureすると無制限にSentry quotaを焼ける増幅経路になる。captureしないことを固定する。
  it('MFA assurance lookup 失敗は token 交換に到達せず、Sentryへcaptureしない', async () => {
    resolveMfaAssurance.mockResolvedValue({
      currentLevel: null,
      nextLevel: null,
      lookupFailed: true,
    });

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('assurance_lookup_failed');
    expect(fetch).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // cookie は署名しておらず HttpOnly は JS を止めるだけなので、ユーザー自身は devtools や
  // curl で中身を作れる。start を一度も踏まずに callback へ直接来られるため、start 側の
  // 403 だけでは Free ユーザーを止められない
  it('Pro でないユーザーは cookie と state が整合していても接続を作れない', async () => {
    checkEntitlementForUser.mockResolvedValue('denied');

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('pro_required');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('subscription の参照に失敗したら接続を保存しない', async () => {
    checkEntitlementForUser.mockResolvedValue('lookup_failed');

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('subscription_check_failed');
    expect(saveConnection).not.toHaveBeenCalled();
    expect(captureUnexpectedError).toHaveBeenCalled();
  });

  // cookie が自作できる以上、start を踏まずに callback を叩き続けられる。無制限だと
  // Google の token endpoint への往復が青天井になる
  it('rate limit を超えたら token 交換に到達しない', async () => {
    rateLimit.mockResolvedValue({ success: false });

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('rate_limited');
    expect(fetch).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('rate limit backend が落ちても接続は続行する', async () => {
    rateLimit.mockRejectedValue(new Error('redis unavailable'));

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(saveConnection).toHaveBeenCalled();
  });

  it('古い code による失敗（invalid_grant）は Sentry へ送らない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('authorization_expired');
    // 誰でも起こせるので、capture すると quota を焼く増幅経路になる
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  // invalid_grant だけを抑制する。設定不備や Google 障害まで巻き込むと、全接続が
  // 失敗しているのに無通知になる
  it.each([
    ['invalid_client（client_secret 不一致）', 'invalid_client', 401],
    ['redirect_uri_mismatch（GCP 登録漏れ）', 'redirect_uri_mismatch', 400],
    ['Google 側の障害', 'internal_failure', 500],
  ])('%s は Sentry へ送る', async (_label, providerError, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: providerError }), { status })),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('token_exchange_rejected');
    // provider の error 種別が errorCode に残らないと、invalid_client と Google 障害を
    // Sentry 上で区別できない
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ errorCode: providerError, source: 'google_token_endpoint' }),
    );
  });

  it('cookie が無ければ接続を保存しない', async () => {
    const response = await GET(request());

    expect(reasonOf(response)).toBe('missing_state');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('start した user と session が違えば中断する（アカウントすり替え防止）', async () => {
    const response = await GET(withCookie(request(), { userId: OTHER_USER_ID }));

    expect(reasonOf(response)).toBe('session_mismatch');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('state が一致しなければ中断する', async () => {
    const response = await GET(withCookie(request({ state: 'forged-state' })));

    expect(reasonOf(response)).toBe('state_mismatch');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('ユーザーが同意を拒否した場合は access_denied で戻す', async () => {
    const response = await GET(withCookie(request({ error: 'access_denied' })));

    expect(reasonOf(response)).toBe('access_denied');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('カレンダー scope が一つも付与されなければ接続を作らない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              tokenResponse({ scope: 'https://www.googleapis.com/auth/userinfo.email' }),
            ),
            { status: 200 },
          ),
        ),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('scope_not_granted');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  // narrow pair は AND 判定。片方だけでは calendarList.list か events.list のどちらかが
  // 恒久的に 403 になり「接続済みなのに同期されない」状態が残るため、両方揃うまで拒否する（#1982）
  it.each([
    ['calendarlist だけ', CALENDAR_LIST_SCOPE],
    ['events だけ', CALENDAR_EVENTS_SCOPE],
  ])('narrow pair の片方（%s）しか付与されなければ接続を作らない', async (_label, scope) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(tokenResponse({ scope })), { status: 200 })),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('scope_not_granted');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  // beforeEach の既定 fetch mock がすでに narrow pair を返す（production の主経路）
  it('narrow pair が両方付与されれば calendar.readonly が無くても接続できる', async () => {
    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        grantedScopes: [CALENDAR_LIST_SCOPE, CALENDAR_EVENTS_SCOPE],
      }),
    );
  });

  // Google は要求した短縮形（openid/email）を返す時も、実際には正準 URL 形（userinfo.email 等）
  // を含めて返す（`request()` 直上の既存ケースが同じ形を使っている）。narrow pair だけの mock で
  // 通ることを確認しても、実レスポンス形で通らなければ意味が無い（`test` skill
  // §外部 API 統合の検証、PR #1721 の教訓）
  it('openid / userinfo.email を含む実レスポンス形でも narrow pair で接続できる', async () => {
    const scope = [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      CALENDAR_LIST_SCOPE,
      CALENDAR_EVENTS_SCOPE,
    ].join(' ');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(tokenResponse({ scope })), { status: 200 })),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(saveConnection).toHaveBeenCalled();
  });

  // 既存接続は旧 scope のまま grant 済みのことがあるため、新規の認可リクエストはもう
  // 要求しなくても callback の判定は引き続き通す（#1982、削除条件は hasRequiredCalendarScopes
  // の doc comment を参照）
  it('旧 calendar.readonly のみでも後方互換で接続できる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(tokenResponse({ scope: CALENDAR_SCOPE })), { status: 200 }),
        ),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: [CALENDAR_SCOPE] }),
    );
  });

  it('refresh_token が返らなければ既存接続を触らない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...tokenResponse(), refresh_token: undefined }), {
            status: 200,
          }),
        ),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('missing_refresh_token');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('id_token の aud が違えば拒否する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(tokenResponse({ id_token: idToken({ aud: 'attacker-client-id' }) })),
            { status: 200 },
          ),
        ),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('id_token_audience_mismatch');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('iss は https 付き / なしの両方を受け入れる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(tokenResponse({ id_token: idToken({ iss: 'accounts.google.com' }) })),
            { status: 200 },
          ),
        ),
      ),
    );

    await GET(withCookie(request()));

    expect(saveConnection).toHaveBeenCalled();
  });

  it('成功時は sub を provider_account_id に、email を provider_account_email に入れる', async () => {
    const response = await GET(withCookie(request()));

    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        providerAccountId: 'google-sub-123',
        providerAccountEmail: 'user@example.com',
        grantedScopes: [CALENDAR_LIST_SCOPE, CALENDAR_EVENTS_SCOPE],
        refreshToken: 'refresh-token',
      }),
    );

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/ja/settings/integrations');
    expect(location.searchParams.get('calendar')).toBe('connected');
  });

  // #2156(a): saveConnection の throw（token 交換済み・idToken parse 済みの後）は
  // outer catch でしか拾えない。ここで orphan grant の revoke が漏れていた。
  it('saveConnection が DB 障害で throw したら孤立 grant を revoke し connection_failed を返す', async () => {
    saveConnection.mockRejectedValueOnce(new Error('db unavailable'));

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('connection_failed');
    expect(revokeOrphanedGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'google-sub-123',
        refreshToken: 'refresh-token',
      }),
    );
  });

  it('scope の連続スペースで空文字が混ざらない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(tokenResponse({ scope: `  ${CALENDAR_SCOPE}   openid  ` })), {
            status: 200,
          }),
        ),
      ),
    );

    await GET(withCookie(request()));

    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: [CALENDAR_SCOPE, 'openid'] }),
    );
  });

  it('cookie の locale が既知でなければ default locale へ落とす（open redirect 防止）', async () => {
    const response = await GET(
      withCookie(request({ state: 'forged-state' }), { locale: '/evil.example' }),
    );

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.host).toBe('app.dayopt.app');
    expect(location.pathname).toBe('/en/settings/integrations');
  });

  it('token 交換が拒否されたら接続を保存しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
      ),
    );

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('authorization_expired');
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('成功・失敗いずれでも flow cookie を消す', async () => {
    const success = await GET(withCookie(request()));
    expect(success.cookies.get('__Host-dayopt-calendar-connect')?.maxAge).toBe(0);

    const failure = await GET(withCookie(request({ state: 'forged-state' })));
    expect(failure.cookies.get('__Host-dayopt-calendar-connect')?.maxAge).toBe(0);
  });

  // scope 検査は reconnect 分岐より前に走る。reconnect flow でも narrow pair の片方が
  // 欠けていれば同じ scope_not_granted で拒否し、reconnect 対象の照会にも進まない
  // （behavior-verifier 指摘のギャップ、#1982）
  it('再接続 flow でも narrow pair の片方が欠ければ scope_not_granted で拒否する', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(tokenResponse({ scope: CALENDAR_LIST_SCOPE })), {
            status: 200,
          }),
        ),
      ),
    );

    const response = await GET(withCookie(request(), { reconnectConnectionId: connectionId }));

    expect(reasonOf(response)).toBe('scope_not_granted');
    expect(getReconnectTarget).toHaveBeenCalledWith(USER_ID, connectionId);
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('再接続は選択済みの同じ Google sub だけを条件付き fenced save に通す', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    const response = await GET(withCookie(request(), { reconnectConnectionId: connectionId }));

    expect(reasonOf(response)).toBeNull();
    expect(getReconnectTarget).toHaveBeenCalledWith(USER_ID, connectionId);
    expect(reconnectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: '00000000-0000-4000-8000-0000000000a2',
        userId: USER_ID,
        connectionId,
        providerAccountId: 'google-sub-123',
      }),
    );
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('OAuth 中に切断された再接続対象を復活させず、交換済み token を revoke する', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    reconnectConnection.mockResolvedValueOnce('missing');

    const response = await GET(withCookie(request(), { reconnectConnectionId: connectionId }));

    expect(reasonOf(response)).toBe('reconnect_target_invalid');
    expect(reconnectConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, providerAccountId: 'google-sub-123' }),
    );
    expect(revokeOrphanedGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'google-sub-123',
        refreshToken: 'refresh-token',
      }),
    );
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('fenced save が revoke outbox に移した接続を成功表示しない', async () => {
    saveConnection.mockResolvedValueOnce('enqueued');

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('connection_failed');
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: '00000000-0000-4000-8000-0000000000a2' }),
    );
    expect(revokeOrphanedGrant).not.toHaveBeenCalled();
  });

  it('save RPC の結果が不明なら保存済み token の revoke を避ける', async () => {
    saveConnection.mockRejectedValueOnce(new CalendarConnectionSaveError('unknown'));

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('connection_failed');
    expect(revokeOrphanedGrant).not.toHaveBeenCalled();
  });

  it('別の Google sub を選んだ再接続は保存しない', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    getReconnectTarget.mockResolvedValue({ id: connectionId, providerAccountId: 'expected-sub' });

    const response = await GET(withCookie(request(), { reconnectConnectionId: connectionId }));

    expect(reasonOf(response)).toBe('account_mismatch');
    expect(saveConnection).not.toHaveBeenCalled();
    expect(reconnectConnection).not.toHaveBeenCalled();
    // #2072: token 交換は完了しているので、Dayopt 側に残らない孤立 grant を revoke する。
    expect(revokeOrphanedGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'google-sub-123',
        refreshToken: 'refresh-token',
      }),
    );
  });

  it('再接続先が見つからない場合は code を消費せずに止める', async () => {
    const connectionId = '00000000-0000-4000-8000-0000000000c1';
    getReconnectTarget.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(withCookie(request(), { reconnectConnectionId: connectionId }));

    expect(reasonOf(response)).toBe('reconnect_target_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
    expect(revokeOrphanedGrant).not.toHaveBeenCalled();
  });

  describe('orphan grant revoke（#2072）', () => {
    it('scope_not_granted は refresh_token と id_token が揃っていれば revoke する', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                tokenResponse({ scope: 'https://www.googleapis.com/auth/userinfo.email' }),
              ),
              { status: 200 },
            ),
          ),
        ),
      );

      const response = await GET(withCookie(request()));

      expect(reasonOf(response)).toBe('scope_not_granted');
      expect(revokeOrphanedGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAccountId: 'google-sub-123',
          refreshToken: 'refresh-token',
        }),
      );
    });

    it('scope_not_granted かつ id_token が malformed なら revoke しない（安全側）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                tokenResponse({
                  scope: 'https://www.googleapis.com/auth/userinfo.email',
                  id_token: 'not-a-valid-jwt',
                }),
              ),
              { status: 200 },
            ),
          ),
        ),
      );

      const response = await GET(withCookie(request()));

      expect(reasonOf(response)).toBe('scope_not_granted');
      expect(revokeOrphanedGrant).not.toHaveBeenCalled();
    });

    it('missing_refresh_token では revoke 対象の token が無いため revoke しない', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify(tokenResponse({ refresh_token: undefined })), {
              status: 200,
            }),
          ),
        ),
      );

      const response = await GET(withCookie(request()));

      expect(reasonOf(response)).toBe('missing_refresh_token');
      expect(revokeOrphanedGrant).not.toHaveBeenCalled();
    });
  });

  it('write fence が有効な時は Google の code を消費する前に拒否する', async () => {
    isWriteFenceEnabled.mockResolvedValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('write_fenced');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  /**
   * #1990: token 交換（= code 消費）の直前で残り予算を検査する。
   *
   * `entryTime` を route 入口の 1 回目の `Date.now()`（`deadlineAt` 算出）に固定し、
   * それ以降の**全ての** `Date.now()` 呼び出しには `laterTime` を返す。呼び出し回数を
   * 正確に 2 回だけと決め打ちしない — 将来 route.ts に別の `Date.now()` 呼び出しが増えても
   * （decoy な呼び出しが割り込んでも）テストの意図（「入口」と「危険窓チェック直前」の
   * 2 時点だけを制御する）が壊れない（risk-reviewer 指摘、PR #2075）。
   */
  function mockClockAfterEntry(entryTime: number, laterTime: number) {
    let callCount = 0;
    return vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? entryTime : laterTime;
    });
  }

  it('code 消費前に残り予算が不足していれば token 交換に到達しない', async () => {
    // deadlineAt = 0 + TIME_BUDGET_MS(80_000)。claim 前の残り 1ms（PRE_CLAIM_BUDGET_MS
    // =45_000 未満）。
    const nowSpy = mockClockAfterEntry(0, 79_999);

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBe('budget_exhausted');
    expect(fetch).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('残り予算が十分なら通常どおり token 交換へ進む', async () => {
    // claim 前の残り 45_001ms（PRE_CLAIM_BUDGET_MS を上回る）。
    const nowSpy = mockClockAfterEntry(0, 34_999);

    const response = await GET(withCookie(request()));

    expect(reasonOf(response)).toBeNull();
    expect(fetch).toHaveBeenCalled();
    expect(saveConnection).toHaveBeenCalled();

    nowSpy.mockRestore();
  });
});
