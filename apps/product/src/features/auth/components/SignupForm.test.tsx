import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SignupForm } from './SignupForm';

// シンプルなレンダリングヘルパー（TooltipProviderは不要になった）
function renderWithProviders(ui: React.ReactElement) {
  return render(ui);
}

// モックの設定
const mockPush = vi.fn();
const mockSignUp = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'ja' }),
  useRouter: () => ({
    push: mockPush,
  }),
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
  useAuthStore: (selector: (state: { signUp: typeof mockSignUp }) => typeof mockSignUp) =>
    selector({ signUp: mockSignUp }),
}));

// パスワードチェックのモック（オプショナル機能）
vi.mock('@/lib/auth/pwned-password', () => ({
  checkPasswordPwned: vi.fn().mockResolvedValue(false),
}));

describe('SignupForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('レンダリング', () => {
    it('フォームが正しくレンダリングされる', () => {
      renderWithProviders(<SignupForm />);

      expect(screen.getByRole('heading')).toBeInTheDocument();
      expect(screen.getByLabelText(/auth\.signupForm\.email/)).toBeInTheDocument();
      expect(screen.getByLabelText(/auth\.signupForm\.password/)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }),
      ).toBeInTheDocument();
    });

    it('メール、パスワードが入力可能', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SignupForm />);

      const emailInput = screen.getByLabelText(/auth\.signupForm\.email/);
      const passwordInput = screen.getByLabelText(/auth\.signupForm\.password/);

      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'password123');

      expect(emailInput).toHaveValue('test@example.com');
      expect(passwordInput).toHaveValue('password123');
    });
  });

  describe('バリデーション', () => {
    // DADS準拠: バリデーションは送信時に行われる（リアルタイムインジケーターは削除）

    it('送信ボタンは常に有効（DADS準拠）', () => {
      renderWithProviders(<SignupForm />);

      const submitButton = screen.getByRole('button', {
        name: 'auth.signupForm.createAccountButton',
      });
      // DADS準拠: ボタンは常に有効で、バリデーションは送信時に行う
      expect(submitButton).not.toBeDisabled();
    });

    it('短すぎるパスワードで送信するとバリデーションエラーが表示され signUp を呼ばない', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'short');
      await user.click(screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }));

      // signupSchema の .min(8, 'auth.errors.weakPassword') が発火する
      // FieldError は ＊ prefix を付与するため部分一致で照合する
      expect(await screen.findByText(/auth\.errors\.weakPassword/)).toBeInTheDocument();
      expect(mockSignUp).not.toHaveBeenCalled();
    });
  });

  describe('フォーム送信', () => {
    it('サインアップ成功時にカレンダーページへ遷移する', async () => {
      const user = userEvent.setup();
      mockSignUp.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'password1');

      await user.click(screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }));

      await waitFor(() => {
        expect(mockSignUp).toHaveBeenCalledWith('test@example.com', 'password1');
        expect(mockPush).toHaveBeenCalledWith('/ja/');
      });
    });

    // #2027: 既登録も未分類の失敗も同一の signupUnavailable に収束させる
    // （分岐ごとに違う文言を返すと、その文言差自体が enumeration oracle になるため）
    it('サインアップ失敗時にエラーメッセージが表示される', async () => {
      const user = userEvent.setup();
      mockSignUp.mockResolvedValue({
        data: null,
        error: { message: 'Email already exists' },
      });

      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'existing@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'password1');

      await user.click(screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.signupUnavailable');
      });
    });

    it('送信中はスピナーが表示される', async () => {
      const user = userEvent.setup();
      mockSignUp.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { user: {}, session: {} }, error: null }), 100),
          ),
      );

      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'password1');

      const submitButton = screen.getByRole('button', {
        name: 'auth.signupForm.createAccountButton',
      });
      await user.click(submitButton);

      // 送信中はスピナーが表示される
      await waitFor(() => {
        expect(submitButton.querySelector('svg')).toBeInTheDocument();
      });
    });
  });

  describe('パスワード表示切替', () => {
    it('パスワードフィールドの表示切替が機能する', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SignupForm />);

      const passwordInput = screen.getByLabelText(/auth\.signupForm\.password/);
      expect(passwordInput).toHaveAttribute('type', 'password');

      // パスワード入力欄の親要素内にあるボタンを取得
      const passwordContainer = passwordInput.closest('.relative');
      const toggleButton = passwordContainer?.querySelector('button');
      expect(toggleButton).toBeTruthy();

      await user.click(toggleButton!);

      expect(passwordInput).toHaveAttribute('type', 'text');
    });
  });

  describe('グレースフルデグラデーション', () => {
    it('パスワードチェックAPIが失敗してもサインアップ可能', async () => {
      const user = userEvent.setup();

      // パスワードチェックが例外を投げる状態をシミュレート
      const { checkPasswordPwned } = await import('@/lib/auth/pwned-password');
      vi.mocked(checkPasswordPwned).mockRejectedValueOnce(new Error('API Error'));

      mockSignUp.mockResolvedValue({
        data: { user: { id: '123' }, session: {} },
        error: null,
      });

      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'password1');

      await user.click(screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }));

      // APIエラーでもサインアップは続行される
      await waitFor(() => {
        expect(mockSignUp).toHaveBeenCalled();
      });
    });

    it('漏洩パスワード検出時はエラーが表示される', async () => {
      const user = userEvent.setup();

      const { checkPasswordPwned } = await import('@/lib/auth/pwned-password');
      vi.mocked(checkPasswordPwned).mockResolvedValueOnce(true);

      renderWithProviders(<SignupForm />);

      await user.type(screen.getByLabelText(/auth\.signupForm\.email/), 'test@example.com');
      await user.type(screen.getByLabelText(/auth\.signupForm\.password/), 'password1');

      await user.click(screen.getByRole('button', { name: 'auth.signupForm.createAccountButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.pwnedPassword');
      });

      // サインアップは呼ばれない
      expect(mockSignUp).not.toHaveBeenCalled();
    });
  });
});
