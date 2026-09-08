/**
 * Zustand認証ストア
 * Context APIから移行してパフォーマンスを最適化
 *
 * @see docs/product/specs/auth.md
 */
import { logger } from '@/lib/logger';
import { captureUnexpectedAuthError, observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/client';
import { clearPersistedQueryCache } from '@/lib/tanstack-query/persist-storage';
import type {
  AuthError,
  AuthResponse,
  OAuthResponse,
  Session,
  User,
  UserResponse,
} from '@supabase/supabase-js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import { getAuthErrorKey, resolveAuthErrorKey } from '@/lib/auth-error';

interface UserMetadata {
  [key: string]: string | number | boolean | null;
}

interface AuthState {
  // State
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  /** セッションが失効したことを示すフラグ（UIで通知→リダイレクトに使用） */
  _sessionExpired: boolean;

  // Actions
  initialize: () => Promise<void>;
  signUp: (
    email: string,
    password: string,
    options?: { captchaToken?: string; metadata?: UserMetadata },
  ) => Promise<AuthResponse>;
  signIn: (
    email: string,
    password: string,
    options?: { captchaToken?: string },
  ) => Promise<AuthResponse>;
  signInWithOAuth: (provider: 'google') => Promise<OAuthResponse>;
  signOut: () => Promise<{ error: AuthError | null }>;
  resetPassword: (
    email: string,
    options?: { captchaToken?: string },
  ) => Promise<{ error: AuthError | null }>;
  // @supabase/auth-js 2.106.2 以降 updateUser は session を含まない UserResponse を返す
  updatePassword: (password: string) => Promise<UserResponse>;
  clearError: () => void;

  // Internal
  _setUser: (user: User | null) => void;
  _setSession: (session: Session | null) => void;
  _setLoading: (loading: boolean) => void;
  _setError: (error: string | null) => void;
}

/** 認証状態を管理するZustandストア */
export const useAuthStore = create<AuthState>()(
  devtools(
    (set, _get) => ({
      // Initial state
      user: null,
      session: null,
      loading: true,
      error: null,
      _sessionExpired: false,

      // Initialize authentication state
      initialize: async () => {
        // オフライン時はタイムアウトを延長（偽ログアウト防止）
        const isOffline =
          typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine;
        const TIMEOUT_MS = isOffline ? 30_000 : 5_000;

        try {
          const supabase = createClient();

          // タイムアウト付きでgetSession実行
          const sessionPromise = observeAuthOperation('get_session', () =>
            supabase.auth.getSession(),
          );
          const timeoutPromise = new Promise<{ data: { session: null }; error: null }>(
            (resolve) => {
              setTimeout(() => {
                logger.warn('[AuthStore] Session retrieval timed out, proceeding without session');
                resolve({ data: { session: null }, error: null });
              }, TIMEOUT_MS);
            },
          );

          const { data, error } = await Promise.race([sessionPromise, timeoutPromise]);

          if (error) {
            logger.error('[AuthStore] Session retrieval error:', error);
            // エラー時もloadingをfalseにして画面表示を許可
            set({ error: null, loading: false, user: null, session: null });
            return;
          }

          set({
            session: data.session,
            user: data.session?.user ?? null,
            loading: false,
            error: null,
          });

          // Auth state changeリスナーは非同期で設定（ブロックしない）
          try {
            const {
              data: { subscription },
            } = supabase.auth.onAuthStateChange((event, session) => {
              const previousUser = _get().user;
              set({
                session,
                user: session?.user ?? null,
              });

              // C2: セッション失効の検出 — 以前ログイン済みだったのに session が消えた場合
              if (previousUser && !session?.user && event === 'SIGNED_OUT') {
                set({ _sessionExpired: true });
                // 永続化 query cache を破棄する（#2619）。UI の logout 経路（useLogout /
                // 設定画面 / session timeout）はどれもここを通るので、経路ごとの書き漏らしに
                // 依存せず 1 箇所で閉じる。memory 側は QueryCacheAuthBoundary が担当。
                void clearPersistedQueryCache();
              }
            });

            // Cleanup subscription on unmount
            if (typeof window !== 'undefined') {
              window.addEventListener('beforeunload', () => {
                subscription.unsubscribe();
              });
            }
          } catch (listenerError) {
            logger.warn('[AuthStore] Failed to set up auth state listener:', listenerError);
            captureUnexpectedAuthError(listenerError, { operation: 'subscribe_auth_state' });
            // リスナー設定失敗は致命的ではない
          }
        } catch (err) {
          logger.error('[AuthStore] Initialization error:', err);
          captureUnexpectedAuthError(err, { operation: 'initialize' });
          // エラー時もloadingをfalseにして画面表示を許可
          set({ error: null, loading: false, user: null, session: null });
        }
      },

      // Sign up with email and password
      signUp: async (email, password, options) => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const result = await supabase.auth.signUp({
            email,
            password,
            options: {
              // 確認メールのリンク検証後の着地先。send-auth-email hook が
              // origin + path を confirm route の next に変換する
              emailRedirectTo: `${window.location.origin}/week`,
              ...(options?.captchaToken && { captchaToken: options.captchaToken }),
              ...(options?.metadata && { data: options.metadata }),
            },
          });

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'sign_up' });
            const safeError = getAuthErrorKey(
              { message: result.error.message, code: result.error.code },
              'signup',
            );
            set({ error: safeError, loading: false });
          } else {
            set({
              session: result.data.session,
              user: result.data.user,
              loading: false,
              error: null,
            });
          }

          return result;
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'sign_up' });
          const safeError = resolveAuthErrorKey(err, 'signup');
          set({ error: safeError, loading: false });
          return {
            data: { user: null, session: null },
            error: { message: safeError } as AuthError,
          };
        }
      },

      // Sign in with email and password
      signIn: async (email, password, options) => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const supabaseOptions = options?.captchaToken
            ? { captchaToken: options.captchaToken }
            : undefined;
          const result = await supabase.auth.signInWithPassword({
            email,
            password,
            ...(supabaseOptions && { options: supabaseOptions }),
          });

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'sign_in' });
            const safeError = getAuthErrorKey(
              { message: result.error.message, code: result.error.code },
              'login',
            );
            set({ error: safeError, loading: false });
          } else {
            set({
              session: result.data.session,
              user: result.data.user,
              loading: false,
              error: null,
            });
          }

          return result;
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'sign_in' });
          const safeError = resolveAuthErrorKey(err, 'login');
          set({ error: safeError, loading: false });
          return {
            data: { user: null, session: null },
            error: { message: safeError } as AuthError,
          };
        }
      },

      // Sign in with OAuth
      signInWithOAuth: async (provider) => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const result = await supabase.auth.signInWithOAuth({
            provider,
            options: {
              redirectTo: `${window.location.origin}/auth/callback`,
            },
          });

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'sign_in_oauth' });
            const safeError = getAuthErrorKey(
              { message: result.error.message, code: result.error.code },
              'oauth',
            );
            set({ error: safeError, loading: false });
          }

          return result;
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'sign_in_oauth' });
          const safeError = resolveAuthErrorKey(err, 'oauth');
          set({ error: safeError, loading: false });
          return {
            data: { provider, url: null },
            error: { message: safeError } as AuthError,
          };
        }
      },

      // Sign out
      signOut: async () => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const result = await supabase.auth.signOut();

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'sign_out' });
            set({ error: 'auth.errors.unexpectedError', loading: false });
          } else {
            set({
              user: null,
              session: null,
              loading: false,
              error: null,
            });
          }

          return { error: result.error };
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'sign_out' });
          set({ error: 'auth.errors.unexpectedError', loading: false });
          return { error: { message: 'auth.errors.unexpectedError' } as AuthError };
        }
      },

      // Reset password
      // OWASP: パスワードリセットはエラーでも成功メッセージを表示（メール存在の漏洩防止）
      resetPassword: async (email, options) => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const result = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/auth/reset-password`,
            // Supabase 側で Bot Protection が有効なため、token が無いと /recover は
            // captcha_failed で 400 を返す（送信自体が成立しない）
            ...(options?.captchaToken && { captchaToken: options.captchaToken }),
          });

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'reset_password' });
            const safeError = getAuthErrorKey(
              { message: result.error.message, code: result.error.code },
              'resetPassword',
            );
            set({ error: safeError, loading: false });
          } else {
            set({ loading: false });
          }

          return { error: result.error };
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'reset_password' });
          set({ error: 'auth.errors.unexpectedError', loading: false });
          return { error: { message: 'auth.errors.unexpectedError' } as AuthError };
        }
      },

      // Update password
      updatePassword: async (password) => {
        set({ loading: true, error: null });

        try {
          const supabase = createClient();
          const result = await supabase.auth.updateUser({ password });

          if (result.error) {
            captureUnexpectedAuthError(result.error, { operation: 'update_password' });
            const safeError = getAuthErrorKey(
              { message: result.error.message, code: result.error.code },
              'updatePassword',
            );
            set({ error: safeError, loading: false });
          } else {
            // recovery でパスワードを変更した後は他端末の session を失効させる。
            // アカウント乗っ取り被害者が最も自然に取る回復操作（パスワードリセット）で
            // 攻撃者の refresh token を道連れにする。失敗してもパスワード更新自体は
            // 成功しているため、結果は分岐させない（PasswordChangeDialog と同じ扱い）。
            //
            // 失敗は throw だけでなく `{ error }` の resolve でも起こる（auth-js の
            // `signOut` はネットワーク/HTTP 失敗を返り値エラーとして返す設計）ため両方
            // 見る。一時的な失敗を想定して 1 回だけ再試行する。store は component 跨ぎの
            // i18n 文言を持てずユーザー通知ができないため、再試行後も失敗したら諦める
            // （`observeAuthOperation` 内の `captureUnexpectedAuthError` で Sentry には残る）。
            let signOutSucceeded = false;
            for (let attempt = 0; attempt < 2 && !signOutSucceeded; attempt++) {
              try {
                const { error: signOutError } = await observeAuthOperation(
                  'sign_out_other_sessions',
                  () => supabase.auth.signOut({ scope: 'others' }),
                );
                signOutSucceeded = !signOutError;
              } catch {
                // `observeAuthOperation` は catch した例外を re-throw する契約なので、
                // ここで握り潰さないと外側の catch に落ち、成功した更新が失敗として
                // 返ってしまう。次の attempt へ（最終 attempt なら諦める）。
              }
            }
            set({ loading: false });
          }

          return result;
        } catch (err) {
          captureUnexpectedAuthError(err, { operation: 'update_password' });
          set({ error: 'auth.errors.unexpectedError', loading: false });
          return {
            data: { user: null },
            error: { message: 'auth.errors.unexpectedError' } as AuthError,
          };
        }
      },

      // Clear error
      clearError: () => {
        set({ error: null });
      },

      // Internal setters (for direct state manipulation if needed)
      _setUser: (user) => set({ user }),
      _setSession: (session) => set({ session }),
      _setLoading: (loading) => set({ loading }),
      _setError: (error) => set({ error }),
    }),
    {
      name: 'auth-store',
      enabled: process.env.NODE_ENV !== 'production',
    },
  ),
);

/** セッション失効フラグを選択するセレクター */
export const selectSessionExpired = (state: AuthState) => state._sessionExpired;
