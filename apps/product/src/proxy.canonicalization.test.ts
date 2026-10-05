/**
 * proxy の認可判定と next-intl の rewrite 判定が、同じ正規化を通しているかを
 * **実物の next-intl を通して**固定するテスト。
 *
 * `proxy.test.ts` は `next-intl/middleware` を mock しているため、proxy 側の
 * decode しか見えず「判定側と rewrite 側の食い違い」を原理的に検出できない。
 * それがまさに percent-encoding バイパス（claude-security C1）を生んだ構造なので、
 * ここだけ mock を外し、次の不変条件を class ごと固定する:
 *
 *   **rewrite 先が protected route に解決されるなら、proxy は 200 を返してはならない。**
 *
 * next-intl の upgrade で `sanitizePathname`（utils.js:187）の内容が変わると
 * このテストが落ちて drift に気づける。
 */
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  captureUnexpectedError: vi.fn(),
}));

// next-intl/middleware は **あえて mock しない**（このテストの存在理由）。
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: mocks.captureUnexpectedError,
  observeAuthOperation: (_operation: string, call: () => PromiseLike<unknown>) => call(),
}));

vi.mock('@/lib/supabase/middleware', () => ({ updateSession: mocks.updateSession }));

import { proxy } from './proxy';

function mockUnauthenticatedSession() {
  mocks.updateSession.mockResolvedValue({
    response: NextResponse.next(),
    user: null,
    supabase: { auth: {} },
  });
}

function mockAal1Session() {
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
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
            data: { currentLevel: 'aal1', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
    },
  });
}

// next-intl が rewrite 先として protected route を指すのに、proxy が素通しして
// しまう形。すべて encode 済み or スラッシュ由来なので browser / CDN で
// 正規化されずサーバまで到達する。
const BYPASS_SHAPES = [
  ['TAB を encode', 'https://app.dayopt.app/%09'],
  ['LF を segment 区切りに', 'https://app.dayopt.app/%0A/'],
  ['連続スラッシュ', 'https://app.dayopt.app//'],
  ['locale prefix を encode', 'https://app.dayopt.app/%6a%61/'],
  ['locale 配下の TAB', 'https://app.dayopt.app/ja/%09'],
  ['locale 配下の連続スラッシュ', 'https://app.dayopt.app/ja//'],
  ['settings の TAB', 'https://app.dayopt.app/%09settings'],
  // `%2E` は decode すると `.` になる。認可分類を canonical で行いつつ
  // 静的アセット判定を raw で行わないと、ここが早期 return に落ちて
  // 認証ごと飛ぶ（反証レビュー P2）。
  ['`.` へ decode される %2E', 'https://app.dayopt.app/settings/general%2Ex'],
  ['locale 配下の %2E', 'https://app.dayopt.app/ja/settings/general%2Ex'],
] as const;

describe('proxy canonicalization は実物の next-intl と一致する', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_MAINTENANCE_MODE', 'false');
    vi.stubEnv('SKIP_AUTH_IN_DEV', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(BYPASS_SHAPES)('%s: 未認証なら 200 を返さず login へ送る', async (_label, url) => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest(url));

    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login');
  });

  it.each(BYPASS_SHAPES)('%s: AAL1 なら 200 を返さず MFA gate へ送る', async (_label, url) => {
    mockAal1Session();

    const response = await proxy(new NextRequest(url));

    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/mfa-verify');
  });

  // 正常系が巻き添えで壊れていないこと。上の不変条件を「全部 307 にする」で
  // 満たす退行を防ぐ。
  it.each([
    ['公開ページ', 'https://app.dayopt.app/pricing'],
    ['auth ページ', 'https://app.dayopt.app/auth/login'],
    ['メンテナンスページ', 'https://app.dayopt.app/maintenance'],
    ['静的アセット', 'https://app.dayopt.app/logo.svg'],
    ['_next', 'https://app.dayopt.app/_next/static/chunk.js'],
    ['API', 'https://app.dayopt.app/api/health'],
  ])('%s: 未認証でも redirect されない', async (_label, url) => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest(url));

    expect(response.status).not.toBe(307);
  });

  it('ホームのカレンダーは未認証ならログインへ送る', async () => {
    mockUnauthenticatedSession();

    const response = await proxy(new NextRequest('https://app.dayopt.app/'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/login');
  });
});
