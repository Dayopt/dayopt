/**
 * セッション失効フラグ（`_sessionExpired`）の立ち下がり。
 *
 * このフラグは `SessionMonitorProvider` が「エラー toast + `/auth/login` へ push」に使う。
 * 立てたまま戻らないと、同じタブでサインインし直した直後に再び発火して login へ弾き戻す。
 * logout → login は soft navigation（`useLogout`）で module state が生き残るため、
 * 通常のログアウト経路だけで再現する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuthChangeHandler = (
  event: string,
  session: { user: { id: string } } | null,
) => void | Promise<void>;

const listeners: AuthChangeHandler[] = [];
const unsubscribed: number[] = [];
const mockGetSession = vi.fn();
const mockSignInWithPassword = vi.fn();
const mockSignUp = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      onAuthStateChange: (handler: AuthChangeHandler) => {
        const index = listeners.length;
        listeners.push(handler);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                unsubscribed.push(index);
                listeners[index] = () => undefined;
              },
            },
          },
        };
      },
    },
  }),
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedAuthError: vi.fn(),
  observeAuthOperation: (_name: string, operation: () => unknown) => operation(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/tanstack-query/persist-storage', () => ({
  clearPersistedQueryCache: vi.fn().mockResolvedValue(undefined),
}));

import { resetAuthSubscriptionForTest, selectSessionExpired, useAuthStore } from './useAuthStore';

const SESSION = { user: { id: 'user-a' } };

async function emit(event: string, session: { user: { id: string } } | null): Promise<void> {
  for (const listener of listeners) {
    await listener(event, session);
  }
}

describe('useAuthStore の _sessionExpired', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetAuthSubscriptionForTest();
    listeners.length = 0;
    unsubscribed.length = 0;
    useAuthStore.setState({ user: null, session: null, loading: true, error: null });
    mockGetSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    await useAuthStore.getState().initialize();
  });

  it('サインイン済みから session が消えたら立つ', async () => {
    await emit('SIGNED_OUT', null);

    expect(selectSessionExpired(useAuthStore.getState())).toBe(true);
  });

  it('同じタブでサインインし直したら下りる', async () => {
    await emit('SIGNED_OUT', null);
    expect(selectSessionExpired(useAuthStore.getState())).toBe(true);

    await emit('SIGNED_IN', SESSION);

    expect(selectSessionExpired(useAuthStore.getState())).toBe(false);
  });

  it('token 更新など session を伴う event でも下りる', async () => {
    await emit('SIGNED_OUT', null);

    await emit('TOKEN_REFRESHED', SESSION);

    expect(selectSessionExpired(useAuthStore.getState())).toBe(false);
  });

  it('initialize をやり直したら下りる', async () => {
    await emit('SIGNED_OUT', null);

    await useAuthStore.getState().initialize();

    expect(selectSessionExpired(useAuthStore.getState())).toBe(false);
  });
});

describe('signIn 経路の _sessionExpired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
    useAuthStore.setState({ user: null, session: null, loading: false, error: null });
  });

  // 公開ページ（PublicProviders）には AuthStoreInitializer が無く listener も張られない。
  // listener に依存せず、サインイン成功そのもので下ろすことを固定する。
  it('listener が無くてもサインイン成功で下りる', async () => {
    useAuthStore.setState({ _sessionExpired: true });
    mockSignInWithPassword.mockResolvedValue({
      data: { session: SESSION, user: SESSION.user },
      error: null,
    });

    await useAuthStore.getState().signIn('a@example.com', 'pw');

    expect(selectSessionExpired(useAuthStore.getState())).toBe(false);
  });

  it('サインイン失敗では下りない', async () => {
    useAuthStore.setState({ _sessionExpired: true });
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials', code: 'invalid_credentials' },
    });

    await useAuthStore.getState().signIn('a@example.com', 'pw');

    expect(selectSessionExpired(useAuthStore.getState())).toBe(true);
  });
});

// 確認メールの着地先。旧 route を指していると legacy 写像の削除で 404 になる。
describe('signUp の emailRedirectTo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
  });

  it('現行の契約 URL（/calendar）を指す', async () => {
    mockSignUp.mockResolvedValue({ data: { session: null, user: null }, error: null });

    await useAuthStore.getState().signUp('a@example.com', 'pw');

    expect(mockSignUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          emailRedirectTo: `${window.location.origin}/calendar`,
        }),
      }),
    );
  });
});

// `AuthStoreInitializer` の guard は mount ごと。`(app)` ↔ `(auth)` を行き来すると
// initialize が再実行され、解除しないと listener が積み上がる。1 イベントで同じ
// `set` が何度も走り、購読も leak する。
describe('auth state listener の張り直し', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthSubscriptionForTest();
    listeners.length = 0;
    unsubscribed.length = 0;
    useAuthStore.setState({ user: null, session: null, loading: true, error: null });
    mockGetSession.mockResolvedValue({ data: { session: SESSION }, error: null });
  });

  it('initialize を繰り返しても生きている listener は 1 本だけ', async () => {
    await useAuthStore.getState().initialize();
    await useAuthStore.getState().initialize();
    await useAuthStore.getState().initialize();

    expect(listeners.length).toBe(3);
    // 最後の 1 本を残して前は解除されている
    expect(unsubscribed).toEqual([0, 1]);
  });

  it('解除済みの listener はイベントを処理しない', async () => {
    await useAuthStore.getState().initialize();
    await useAuthStore.getState().initialize();

    // 解除済みの 0 番へ流しても状態は動かない
    await listeners[0]!('SIGNED_OUT', null);
    expect(selectSessionExpired(useAuthStore.getState())).toBe(false);

    // 生きている 1 番は従来どおり動く
    await listeners[1]!('SIGNED_OUT', null);
    expect(selectSessionExpired(useAuthStore.getState())).toBe(true);
  });
});
