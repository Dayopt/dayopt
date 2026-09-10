import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from './LoginForm';

// シンプルなレンダリングヘルパー（TooltipProviderは不要になった）
function renderWithProviders(ui: React.ReactElement) {
  return render(ui);
}

// モックの設定
const mockPush = vi.fn();
const mockSignIn = vi.fn();

// MFAモックの状態を管理（テストごとに変更可能）
const mockMfaGetAAL = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'ja' }),
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@dayopt/i18n/navigation', async () => {
  const React = await import('react');
  return {
    Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...props }, children),
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => '/',
  };
});

vi.mock('@/features/auth/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { signIn: typeof mockSignIn }) => typeof mockSignIn) =>
    selector({ signIn: mockSignIn }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mockMfaGetAAL,
      },
    },
  }),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトのMFAモック（MFA不要）
    mockMfaGetAAL.mockResolvedValue({ data: null, error: null });
    // デフォルトのSearchParamsをリセット
    mockSearchParams = new URLSearchParams();
  });

  describe('レンダリング', () => {
    it('フォームが正しくレンダリングされる', () => {
      renderWithProviders(<LoginForm />);

      expect(screen.getByRole('heading')).toBeInTheDocument();
      expect(screen.getByLabelText(/auth\.loginForm\.email/)).toBeInTheDocument();
      expect(screen.getByLabelText(/auth\.loginForm\.password/)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'auth.loginForm.loginButton' }),
      ).toBeInTheDocument();
    });

    it('メールとパスワードが入力可能', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LoginForm />);

      const emailInput = screen.getByLabelText(/auth\.loginForm\.email/);
      const passwordInput = screen.getByLabelText(/auth\.loginForm\.password/);

      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'password123');

      expect(emailInput).toHaveValue('test@example.com');
      expect(passwordInput).toHaveValue('password123');
    });

    it('パスワード表示切替ボタンが機能する', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LoginForm />);

      const passwordInput = screen.getByLabelText(/auth\.loginForm\.password/);
      expect(passwordInput).toHaveAttribute('type', 'password');

      // パスワード入力欄の親要素内にあるボタンを取得
      const passwordContainer = passwordInput.closest('.relative');
      const toggleButton = passwordContainer?.querySelector('button');
      expect(toggleButton).toBeTruthy();

      await user.click(toggleButton!);

      expect(passwordInput).toHaveAttribute('type', 'text');
    });
  });

  describe('フォーム送信', () => {
    it('ログイン成功時にカレンダーページへ遷移する', async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('test@example.com', 'password123');
        expect(mockPush).toHaveBeenCalledWith('/ja/calendar');
      });
    });

    it('ログイン失敗時にエラーメッセージが表示される', async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: null,
        error: { message: 'Invalid credentials' },
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'wrongpassword');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.invalidCredentials');
      });
    });

    it('送信中はローディング状態になる', async () => {
      const user = userEvent.setup();
      // 遅延するPromiseを作成
      mockSignIn.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { user: {}, session: {} }, error: null }), 100),
          ),
      );

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');

      const submitButton = screen.getByRole('button', { name: 'auth.loginForm.loginButton' });
      await user.click(submitButton);

      // ローディング中はボタンが無効化される
      expect(submitButton).toBeDisabled();
    });

    it('予期しないエラー時にエラーメッセージが表示される', async () => {
      const user = userEvent.setup();
      mockSignIn.mockRejectedValue(new Error('Network error'));

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  describe('バリデーション', () => {
    it('必須フィールドが空の場合は送信されない', async () => {
      renderWithProviders(<LoginForm />);

      const submitButton = screen.getByRole('button', { name: 'auth.loginForm.loginButton' });
      fireEvent.click(submitButton);

      // ブラウザの必須バリデーションによりsignInは呼ばれない
      expect(mockSignIn).not.toHaveBeenCalled();
    });
  });

  describe('MFA対応', () => {
    it('MFA必要時にMFA検証ページへ遷移する', async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      // MFAが必要な状態をモック
      mockMfaGetAAL.mockResolvedValue({
        data: { currentLevel: 'aal1', nextLevel: 'aal2' },
        error: null,
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/ja/auth/mfa-verify');
      });
    });
  });

  describe('エラーハンドリング', () => {
    it('MFAチェック失敗時はMFA検証ページへ遷移する', async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      // MFAチェックがエラーを返す（セキュリティ上、MFA検証ページへ誘導）
      mockMfaGetAAL.mockResolvedValue({
        data: null,
        error: { message: 'MFA check failed' },
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      // MFAエラー時はセキュリティのためMFA検証ページへ
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/ja/auth/mfa-verify');
      });
    });

    it('MFAチェックで例外が発生してもエラー表示される', async () => {
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      // MFAチェックが例外を投げる
      mockMfaGetAAL.mockRejectedValue(new Error('MFA Error'));

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      // 例外時はエラーメッセージが表示される
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  describe('redirectパラメータ対応', () => {
    it('redirectパラメータがある場合、ログイン後にそのパスへ遷移する', async () => {
      mockSearchParams = new URLSearchParams(
        `redirect=${encodeURIComponent('/calendar/week?date=2026-03-25&panel=review')}`,
      );
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/ja/calendar/week?date=2026-03-25&panel=review');
      });
    });

    it('locale付きredirectパラメータを重複させない', async () => {
      mockSearchParams = new URLSearchParams(`redirect=${encodeURIComponent('/ja/settings')}`);
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/ja/settings');
      });
    });

    it('不正なredirectパラメータはフォールバックされる', async () => {
      mockSearchParams = new URLSearchParams('redirect=//evil.com');
      const user = userEvent.setup();
      mockSignIn.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<LoginForm />);

      await user.type(screen.getByLabelText(/auth\.loginForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.loginForm\.password/), 'password123');
      await user.click(screen.getByRole('button', { name: 'auth.loginForm.loginButton' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/ja/calendar');
      });
    });
  });
});
