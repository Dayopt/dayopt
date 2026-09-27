import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyOtp = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const deliverWelcomeEmailOnce = vi.hoisted(() => vi.fn());
const createSignupAnalyticsClaim = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/features/auth/server/welcome-email', () => ({ deliverWelcomeEmailOnce }));
vi.mock('@/lib/analytics/signup-analytics-claim', () => ({
  createSignupAnalyticsClaim,
  SIGNUP_ANALYTICS_CLAIM_COOKIE: '__Host-dayopt_signup_claim',
  SIGNUP_ANALYTICS_CLAIM_MAX_AGE_SECONDS: 600,
}));
vi.mock('@/lib/sentry', () => ({
  // 計測 wrapper は素通しさせる。ここで検証したいのは着地先の分岐であって観測ではない。
  observeAuthOperation: (_name: string, operation: () => unknown) => operation(),
}));

import { GET } from './route';

const SESSION = { access_token: 'token', refresh_token: 'refresh' };

function request(query: string) {
  return new NextRequest(`https://app.dayopt.app/auth/confirm?${query}`);
}

function locationOf(response: Response) {
  return new URL(response.headers.get('location') ?? '');
}

describe('auth confirm route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClient.mockResolvedValue({ auth: { verifyOtp } });
    deliverWelcomeEmailOnce.mockResolvedValue(true);
    createSignupAnalyticsClaim.mockReturnValue('signed-token');
  });

  // #1956: session がある時だけ保護ページへ送る。これが従来の正常系。
  it('session が確立できたら next の保護ページへ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: SESSION }, error: null });

    const response = await GET(
      request('token_hash=hash&type=email_change&next=%2Fsettings%2Faccount'),
    );

    expect(locationOf(response).pathname).toBe('/settings/account');
  });

  // 本件の回帰。session が無いまま保護ページへ送ると middleware に弾かれ、
  // ユーザーには確認できたのかどうかが伝わらない無言バウンスになる。
  it('email_change の片側確認で session が無い時は保護ページへ送らず結果ページへ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: null });

    const response = await GET(
      request('token_hash=hash&type=email_change&next=%2Fsettings%2Faccount'),
    );
    const location = locationOf(response);

    expect(location.pathname).toBe('/auth/confirmed');
    expect(location.searchParams.get('status')).toBe('email_change_confirmed');
    // 保護ページへの redirect を残すと、login 後にそこへ飛ばされて同じ混乱が起きる。
    expect(location.searchParams.get('redirect')).toBeNull();
  });

  // auth-js は `session?.access_token` がある時だけ session を保存する。token を伴わない
  // session オブジェクトで保護ページへ送ると、cookie が無いまま middleware に弾かれる。
  it('access_token を伴わない session では保護ページへ送らない', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { user: {} } }, error: null });

    const response = await GET(
      request('token_hash=hash&type=email_change&next=%2Fsettings%2Faccount'),
    );

    expect(locationOf(response).pathname).toBe('/auth/confirmed');
  });

  // 無言バウンスは email_change 固有ではない。メールクライアントの browser から
  // 開いた signup / recovery でも session 無しで着地しうるので、type で特例にしない。
  it.each(['signup', 'recovery', 'magiclink'])(
    'session が無ければ %s でも状況を伝える着地にする',
    async (type) => {
      verifyOtp.mockResolvedValue({ data: { session: null }, error: null });

      const response = await GET(request(`token_hash=hash&type=${type}&next=%2Fcalendar`));
      const location = locationOf(response);

      expect(location.pathname).toBe('/auth/confirmed');
      expect(location.searchParams.get('status')).toBe('email_confirmed');
    },
  );

  // signup は confirm route を共用する。session が立つ通常経路で
  // next へ行く挙動が変わっていないことを固定する（regression 対象）。
  it('signup は session が立てば従来どおり next へ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: SESSION }, error: null });

    const response = await GET(request('token_hash=hash&type=signup&next=%2Fcalendar'));

    expect(locationOf(response).pathname).toBe('/calendar');
  });

  it('確認済みの新規登録だけに署名付きの一時claimを設定する', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: { ...SESSION, user: { id: 'new-user' } } },
      error: null,
    });

    const response = await GET(request('token_hash=hash&type=signup&next=%2Fcalendar'));

    expect(deliverWelcomeEmailOnce).toHaveBeenCalledWith('new-user');
    expect(createSignupAnalyticsClaim).toHaveBeenCalledWith('new-user', 'email');
    expect(locationOf(response).searchParams.get('signup_claim')).toBe('1');
    expect(response.headers.get('set-cookie')).toContain('__Host-dayopt_signup_claim=signed-token');
  });

  // #1928: recovery は next を無視して固定で /auth/reset-password へ送る。メール送信経路
  // （Edge Function の redirect_to 構築、または Redirect URLs allowlist）の欠落で next が
  // 付かないと fallback の /week へ落ち、パスワード設定フォームに到達できない事故があった。
  it('recovery は session が立てば next を無視して /auth/reset-password へ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: SESSION }, error: null });

    const response = await GET(request('token_hash=hash&type=recovery&next=%2Fcalendar'));

    expect(locationOf(response).pathname).toBe('/auth/reset-password');
  });

  // recovery で next が無い（当初の #1928 症状: next 自体が付与されなかった）場合も
  // 固定 path へ送る。next の値に依存しない設計であることを確認する。
  it('recovery は next が無くても /auth/reset-password へ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: SESSION }, error: null });

    const response = await GET(request('token_hash=hash&type=recovery'));

    expect(locationOf(response).pathname).toBe('/auth/reset-password');
  });

  // 失敗も同じ結果ページへ送る。login へ送ると、認証済み browser では proxy が /week へ
  // 弾いて理由が表示されない（成功側と同じ穴が失敗側に残る）。
  it('検証に失敗したら failed を付けて結果ページへ送る', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: new Error('invalid token') });

    const response = await GET(request('token_hash=hash&type=email_change'));
    const location = locationOf(response);

    expect(location.pathname).toBe('/auth/confirmed');
    expect(location.searchParams.get('status')).toBe('failed');
  });

  it('token_hash や type が欠けていたら verifyOtp を呼ばずに失敗として扱う', async () => {
    const response = await GET(request('type=email_change'));

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(locationOf(response).searchParams.get('status')).toBe('failed');
  });

  // open redirect 防御を緩めていないこと。next は getSafeRedirectPath を通る。
  it('外部オリジンの next は受け付けない', async () => {
    verifyOtp.mockResolvedValue({ data: { session: SESSION }, error: null });

    const response = await GET(
      request('token_hash=hash&type=signup&next=https%3A%2F%2Fevil.example.com%2Fsteal'),
    );
    const location = locationOf(response);

    expect(location.origin).toBe('https://app.dayopt.app');
    expect(location.href).not.toContain('evil.example.com');
  });
});
