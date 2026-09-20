import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  captureUnexpectedError: vi.fn(),
}));

vi.mock('next-intl/middleware', async () => {
  const { NextResponse: MockNextResponse } = await import('next/server');
  return { default: () => () => MockNextResponse.next() };
});

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: mocks.captureUnexpectedError,
  observeAuthOperation: (_operation: string, call: () => PromiseLike<unknown>) => call(),
}));

vi.mock('@/lib/supabase/middleware', () => ({ updateSession: mocks.updateSession }));

import { config, proxy } from './proxy';

function mockAuthenticatedSession(aalResult: {
  data: { currentLevel: string | null; nextLevel: string | null } | null;
  error: unknown;
}) {
  mocks.updateSession.mockResolvedValue({
    response: NextResponse.next(),
    user: { id: 'user-1' },
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'session-token' } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue(aalResult),
        },
      },
    },
  });
}

function mockUnauthenticatedSession() {
  mocks.updateSession.mockResolvedValue({
    response: NextResponse.next(),
    user: null,
    supabase: { auth: {} },
  });
}

describe('proxy MFA gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves the locale when redirecting an AAL1 session with enrolled MFA', async () => {
    mockAuthenticatedSession({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const response = await proxy(new NextRequest('https://app.dayopt.app/ja/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/ja/auth/mfa-verify');
  });

  // #2144: /auth/login は認証済みだと /calendar へ弾かれ、/calendar は protected path
  // なので MFA gate を再度通る。lookupFailed が続く限り無限ループになっていたため、
  // authPathsAllowedWhileAuthenticated 済みの専用ページへ送るよう変更した。
  it('redirects to the session error page when the MFA assurance lookup returns an error', async () => {
    mockAuthenticatedSession({ data: null, error: { message: 'lookup failed' } });

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/auth/session-error');
  });

  // #2144: lookupFailed が続く限り、この redirect 先自身へ再度到達しても
  // /calendar へ弾き返されない（= ループが構造的に閉じている）ことを固定する。
  it.each([
    [
      'locale prefix あり',
      'https://app.dayopt.app/ja/calendar',
      'https://app.dayopt.app/ja/auth/session-error',
    ],
    [
      'locale prefix なし',
      'https://app.dayopt.app/calendar',
      'https://app.dayopt.app/auth/session-error',
    ],
  ])(
    '%s: session error ページへ到達した後も認証済みで /calendar へ送り返されない',
    async (_label, calendarUrl, expectedSessionErrorUrl) => {
      mockAuthenticatedSession({ data: null, error: { message: 'lookup failed' } });

      const first = await proxy(new NextRequest(calendarUrl));
      expect(first.headers.get('location')).toBe(expectedSessionErrorUrl);

      const second = await proxy(new NextRequest(expectedSessionErrorUrl));
      expect(second.status).toBe(200);
      expect(second.headers.get('location')).toBeNull();
    },
  );

  // proxy が catch する予期しない例外（updateSession 自体の throw）も、同じ
  // /auth/login → /calendar の無限ループ shape を持っていた（#2144）。同じ着地先に倒す。
  it('redirects to the session error page when an unexpected proxy error occurs', async () => {
    mocks.updateSession.mockRejectedValue(new Error('unexpected'));

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/auth/session-error');
  });

  // #2144 risk-reviewer 指摘: env misconfiguration 等で updateSession() が
  // persistent に throw すると、/auth/session-error 自身へのリクエストでも
  // catch に落ちる。その時に同じ path へ redirect すると自己ループになるため、
  // この path 自身は redirect せず素通しすることを固定する。
  // #2144 P3（クロスレビュー指摘）: catch 内の判定は pathWithoutLocale（locale を
  // 剥がした path）で行っており、locale prefix ありでも同じ分岐を共有する。
  // 対称性を崩す変更が入ってもすぐ検出できるよう、両ケースを固定する。
  it.each([
    ['locale prefix なし', 'https://app.dayopt.app/auth/session-error'],
    ['locale prefix あり', 'https://app.dayopt.app/ja/auth/session-error'],
  ])(
    '%s: 予期しない例外発生時も session error ページ自身は redirect しない',
    async (_label, url) => {
      mocks.updateSession.mockRejectedValue(new Error('unexpected'));

      const response = await proxy(new NextRequest(url));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it.each([
    { currentLevel: 'aal1', nextLevel: 'aal1' },
    { currentLevel: 'aal2', nextLevel: 'aal2' },
  ])('does not redirect a valid $currentLevel session', async (data) => {
    mockAuthenticatedSession({ data, error: null });

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});

// #1956: メール確認の結果ページは、認証済みの browser で開かれても表示できないといけない。
// helper 単体（access-policy.test.ts）では「locale を剥がした path なら allowlist に一致する」
// までしか固定できず、proxy が生の pathname を渡すよう変わっても検出できない。
// その場合に壊れるのは日本語ユーザーだけなので、proxy を通した実挙動をここで固定する。
describe('proxy auth-path allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [
      'locale prefix あり',
      'https://app.dayopt.app/ja/auth/confirmed?status=email_change_confirmed',
    ],
    ['locale prefix なし', 'https://app.dayopt.app/auth/confirmed?status=email_change_confirmed'],
  ])('%s の確認結果ページは認証済みでも /week へ送らない', async (_label, url) => {
    mockAuthenticatedSession({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  // 対の確認。allowlist に無い auth path は従来どおり /calendar へ送る（allowlist を
  // 広げすぎていないこと、この test が常に 200 を返すだけの空振りでないことの両方を示す）。
  it.each([
    [
      'locale prefix あり',
      'https://app.dayopt.app/ja/auth/login',
      'https://app.dayopt.app/ja/calendar',
    ],
    ['locale prefix なし', 'https://app.dayopt.app/auth/login', 'https://app.dayopt.app/calendar'],
  ])('%s の login は認証済みなら /calendar へ送る', async (_label, url, expected) => {
    mockAuthenticatedSession({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(expected);
  });

  // #2144: lookupFailed は user 状態が曖昧な時にも起きうるため、未認証でも
  // /auth/session-error を表示できる必要がある（認証を要求しない、redirect も起きない）。
  it.each([
    ['locale prefix あり', 'https://app.dayopt.app/ja/auth/session-error'],
    ['locale prefix なし', 'https://app.dayopt.app/auth/session-error'],
  ])('%s の session error ページは未認証でも表示できる', async (_label, url) => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});

// workspace-shell-restructure #2181 Step 2（#2191）: 旧URL → /calendar・/report の
// 写像（overview.md §4-4）を固定する。認証状態を問わない redirect なので
// updateSession をモックせずに検証できる。
describe('proxy legacy workspace redirects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['/week', '/calendar?view=week'],
    ['/day', '/calendar?view=day'],
    ['/2day', '/calendar?view=2day'],
    ['/7day', '/calendar?view=7day'],
  ])('%s → %s（date なし）', async (from, to) => {
    const response = await proxy(new NextRequest(`https://app.dayopt.app${from}`));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`https://app.dayopt.app${to}`);
  });

  it.each([
    ['/week', '/calendar?date=2026-04-20&view=week'],
    ['/day', '/calendar?date=2026-04-20&view=day'],
    ['/3day', '/calendar?date=2026-04-20&view=3day'],
  ])('%s?date=... → %s（date を素通し）', async (from, to) => {
    const response = await proxy(new NextRequest(`https://app.dayopt.app${from}?date=2026-04-20`));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`https://app.dayopt.app${to}`);
  });

  it('locale prefix ありでも /calendar への写像を維持する', async () => {
    const response = await proxy(new NextRequest('https://app.dayopt.app/ja/week?date=2026-04-20'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/ja/calendar?date=2026-04-20&view=week',
    );
  });

  // レポートは週 / 月 / 年の 3 粒度しか持たない（#2575）。旧 `/day` 系リンクも週へ寄せる
  // — 日の解像度はカレンダーの仕事なので、`range=day` という着地点が存在しない。
  it.each([['/day'], ['/week'], ['/3day'], ['/7day']])(
    '%s?panel=review → /report?range=week（panel と reviewTagId は落とす）',
    async (from) => {
      const response = await proxy(
        new NextRequest(
          `https://app.dayopt.app${from}?date=2026-04-20&panel=review&reviewTagId=tag-1`,
        ),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        'https://app.dayopt.app/report?date=2026-04-20&range=week',
      );
    },
  );

  it.each(['diff', 'analytics'])('panel=%s も /report へ写す', async (panel) => {
    const response = await proxy(new NextRequest(`https://app.dayopt.app/day?panel=${panel}`));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/report?range=week');
  });

  it('panel は view より優先される（同時に来たらレポートへ行く）', async () => {
    const response = await proxy(
      new NextRequest('https://app.dayopt.app/week?date=2026-04-20&panel=diff'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/report?date=2026-04-20&range=week',
    );
  });

  it('/review（削除済み旧route）は redirect しない', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/review'));

    // legacy redirect の対象外。以降の通常の未認証 protected-path 判定に委ねられる
    // （/review は isProtectedProductPath に該当しないため 200 のまま通過する）。
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('範囲外の Nday（8day 等）は legacy redirect の対象外・旧route削除後は認可判定にも乗らない（#2181 Step 6）', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/8day'));

    // 8day は resolveLegacyWorkspaceRedirect の対象外（2〜7day のみ許容）。
    // workspaceViewPathPattern（access-policy.ts）は Step 6 で削除済みなので
    // isProtectedProductPath の対象からも外れ、middleware は素通しする。
    // 旧 [nday]/page.tsx も削除済みのため、この URL は Next.js のルーティングで
    // 404 になる（middleware レベルでは 200 素通し、404 は App Router の責務）。
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('/calendar 自身（新URL）は写像の対象外', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar?view=week'));

    // 未認証 protected-path として login へ送られる（legacy redirect ではない）
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/auth/login?redirect=%2Fcalendar%3Fview%3Dweek',
    );
  });
});

// workspace-shell-restructure #2181: /calendar?view= の範囲外検証を edge で行う。
// page.tsx の notFound()（searchParams 依存）は静的シェルの prerender と競合し
// status code に反映されないため（x-nextjs-prerender: 1 で 200 が返る、2026-08-19
// 実測。dynamic = 'force-dynamic' / connection() いずれでも解消せず）、
// 「範囲外 view は 404」の契約を redirect と同じ edge 層で守る。
describe('proxy /calendar view 範囲外検証', () => {
  it('view=8day（範囲外）は edge で 404 を返す', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(
      new NextRequest('https://app.dayopt.app/ja/calendar?view=8day&date=2026-04-20'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('view=week（正当）は素通しして通常の認可判定へ渡る', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar?view=week'));

    // 404 にならず、未認証 protected-path として login へ送られる
    expect(response.status).not.toBe(404);
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/auth/login?redirect=%2Fcalendar%3Fview%3Dweek',
    );
  });

  it('view 省略時は素通しして通常の認可判定へ渡る（page.tsx の既定 week フォールバック対象）', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).not.toBe(404);
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/auth/login?redirect=%2Fcalendar',
    );
  });

  // risk-reviewer 指摘（2026-08-19）: URLSearchParams.get は同一キー重複時に先頭値しか
  // 見ないため、getAll でないと後続の不正値が素通りする。
  it.each([
    ['正当な値の後に範囲外', 'https://app.dayopt.app/calendar?view=week&view=8day'],
    ['範囲外の後に正当な値', 'https://app.dayopt.app/calendar?view=8day&view=week'],
  ])('view が重複し、うち1つでも範囲外なら404にする（%s）', async (_label, url) => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(404);
  });
});

// #2516: updateSession() が refresh 時に返す Cookie / cache headers（sessionContinuity）を、
// proxy が新しく作る全 response（redirect / 404 / 素通し）へ引き継ぐことを固定する。
// 引き継がないと、CDN が Set-Cookie 付きレスポンスをキャッシュし得るセッション漏洩経路になる。
describe('proxy が refresh 後の Cookie / cache headers を全 response へ引き継ぐ（#2516）', () => {
  const REFRESHED_COOKIE = { name: 'sb-refresh', value: 'rotated', options: { path: '/' } };
  const NO_CACHE_HEADERS = {
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    Expires: '0',
    Pragma: 'no-cache',
  };

  function continuity(refreshed: boolean) {
    return refreshed
      ? { cookies: [REFRESHED_COOKIE], headers: NO_CACHE_HEADERS }
      : { cookies: [], headers: {} };
  }

  function refreshedResponse(refreshed: boolean) {
    const response = NextResponse.next();
    if (refreshed) {
      response.cookies.set(REFRESHED_COOKIE.name, REFRESHED_COOKIE.value, REFRESHED_COOKIE.options);
      for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) {
        response.headers.set(key, value);
      }
    }
    return response;
  }

  function mockAuthenticatedSessionWithContinuity(
    aalResult: {
      data: { currentLevel: string | null; nextLevel: string | null } | null;
      error: unknown;
    },
    opts: { refreshed?: boolean } = {},
  ) {
    mocks.updateSession.mockResolvedValue({
      response: refreshedResponse(!!opts.refreshed),
      sessionContinuity: continuity(!!opts.refreshed),
      user: { id: 'user-1' },
      supabase: {
        auth: {
          getSession: vi.fn().mockResolvedValue({
            data: { session: { access_token: 'session-token' } },
            error: null,
          }),
          mfa: {
            getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue(aalResult),
          },
        },
      },
    });
  }

  function mockUnauthenticatedSessionWithContinuity(opts: { refreshed?: boolean } = {}) {
    mocks.updateSession.mockResolvedValue({
      response: refreshedResponse(!!opts.refreshed),
      sessionContinuity: continuity(!!opts.refreshed),
      user: null,
      supabase: { auth: {} },
    });
  }

  function expectSessionCarried(response: NextResponse) {
    expect(response.cookies.get('sb-refresh')?.value).toBe('rotated');
    expect(response.headers.get('cache-control')).toBe(NO_CACHE_HEADERS['Cache-Control']);
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('未認証 → login redirect でも引き継ぐ', async () => {
    mockUnauthenticatedSessionWithContinuity({ refreshed: true });

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.dayopt.app/auth/login?redirect=%2Fcalendar',
    );
    expectSessionCarried(response);
  });

  it('認証済み auth path → /calendar redirect でも引き継ぐ', async () => {
    mockAuthenticatedSessionWithContinuity(
      { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null },
      { refreshed: true },
    );

    const response = await proxy(new NextRequest('https://app.dayopt.app/auth/login'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/calendar');
    expectSessionCarried(response);
  });

  it('MFA aal1→aal2 → mfa-verify redirect でも引き継ぐ', async () => {
    mockAuthenticatedSessionWithContinuity(
      { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null },
      { refreshed: true },
    );

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/auth/mfa-verify');
    expectSessionCarried(response);
  });

  it('MFA lookupFailed → session-error redirect でも引き継ぐ', async () => {
    mockAuthenticatedSessionWithContinuity(
      { data: null, error: { message: 'lookup failed' } },
      { refreshed: true },
    );

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.dayopt.app/auth/session-error');
    expectSessionCarried(response);
  });

  it('catch 経路（updateSession 後の予期しない例外）→ session-error redirect でも引き継ぐ', async () => {
    mockAuthenticatedSessionWithContinuity(
      { data: null, error: { message: 'lookup failed' } },
      { refreshed: true },
    );
    const { logger } = await import('@/lib/logger');
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('boom');
    });

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.headers.get('location')).toBe('https://app.dayopt.app/auth/session-error');
    expectSessionCarried(response);
  });

  it('通常の 200 response でも保持される（非回帰）', async () => {
    mockAuthenticatedSessionWithContinuity(
      { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null },
      { refreshed: true },
    );

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(200);
    expectSessionCarried(response);
  });

  it('refresh が無い redirect には cache headers / cookie を足さない（一律付与ではない）', async () => {
    mockUnauthenticatedSessionWithContinuity();

    const response = await proxy(new NextRequest('https://app.dayopt.app/calendar'));

    expect(response.status).toBe(307);
    expect(response.headers.get('cache-control')).toBeNull();
    expect(response.cookies.get('sb-refresh')).toBeUndefined();
  });
});

// percent-encoding による認可バイパス（claude-security スキャン C1、HIGH）。
//
// `request.nextUrl.pathname` は percent-encoding を保ったまま渡ってくるのに対し、
// next-intl の middleware は `decodeURI` した値で rewrite 先を決める
// （4.13.2 `middleware.js:16` / `:40`）。判定側だけが encode されたままだと
// `/%63alendar` が `isProtectedProductPath` の `startsWith` に一致せず
// 「保護対象ではない」と扱われ、未認証の login redirect（proxy.ts）と
// aal1 の MFA gate の両方を同時に迂回できる。
// 不変条件「proxy の MFA redirect を procedure backstop と引き換えに弱めない」
// （docs/engineering/invariants.md §認証・MFA）を守る回帰テスト。
describe('proxy path canonicalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['先頭 1 文字を encode', 'https://app.dayopt.app/%63alendar'],
    ['複数文字を encode', 'https://app.dayopt.app/%63%61lendar'],
    ['locale prefix を encode', 'https://app.dayopt.app/%6a%61/calendar'],
  ])('%s した protected path でも未認証なら login へ redirect する', async (_label, url) => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login');
  });

  it.each([
    [
      '先頭 1 文字を encode',
      'https://app.dayopt.app/%63alendar',
      'https://app.dayopt.app/auth/mfa-verify',
    ],
    [
      'locale prefix を encode',
      'https://app.dayopt.app/%6a%61/calendar',
      'https://app.dayopt.app/ja/auth/mfa-verify',
    ],
  ])('%s した protected path でも AAL1 なら MFA gate を通る', async (_label, url, expected) => {
    mockAuthenticatedSession({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const response = await proxy(new NextRequest(url));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(expected);
  });

  // decodeURI が URIError を投げる pathname は Next 側でも実ルートへ解決されない。
  // 判定を続けず fail closed で落とす。
  it('decode できない pathname は 404 にする', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/%ZZ'));

    expect(response.status).toBe(404);
  });
});

describe('proxy が OG 画像を locale 解決から外す（#2573）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    mockUnauthenticatedSession();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('config.matcher が /opengraph-image を除外する', () => {
    // 最後の entry が「除外リスト以外の全 path」。拡張子を持たない `/opengraph-image` は
    // `.*\..*` に引っかからないので、名指しの除外が無いと proxy が起動して
    // next-intl が `/en/opengraph-image` へ rewrite し 404 になる。
    const catchAll = config.matcher.at(-1);
    expect(catchAll).toBeDefined();
    const pattern = new RegExp(`^${catchAll}$`);

    expect(pattern.test('/opengraph-image')).toBe(false);
    expect(pattern.test('/sitemap.xml')).toBe(false);
    expect(pattern.test('/calendar')).toBe(true);
    expect(pattern.test('/ja/calendar')).toBe(true);
  });

  it('OG 画像への request で updateSession を呼ばずに素通しする', async () => {
    const response = await proxy(new NextRequest('https://app.dayopt.app/opengraph-image'));

    expect(response.status).toBe(200);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('percent-encode した OG 画像 path も同じ扱いにする', async () => {
    const response = await proxy(new NextRequest('https://app.dayopt.app/%6fpengraph-image'));

    expect(response.status).toBe(200);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});
