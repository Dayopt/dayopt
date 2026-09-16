import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';

import { FieldError } from '@dayopt/components';

import { checkPasswordPwned } from '@/lib/auth/pwned-password';

import { SignupForm } from './SignupForm';

/** SignupForm - サインアップフォーム */
const meta = {
  title: 'Product/Features/Auth/SignupForm',
  component: SignupForm,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs', 'critical'],
  beforeEach: () => {
    mocked(checkPasswordPwned).mockResolvedValue(false);
  },
} satisfies Meta<typeof SignupForm>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト表示 */
export const Default: Story = {};

/** フォーム入力の操作テスト */
export const WithInteraction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // メール入力（id="email"）
    const emailInput = canvas.getByRole('textbox', { name: /メールアドレス/ });
    await userEvent.type(emailInput, 'newuser@example.com');
    await expect(emailInput).toHaveValue('newuser@example.com');

    // パスワード入力（id="password"）
    const passwordInput = canvasElement.querySelector<HTMLInputElement>('#password');
    await expect(passwordInput).not.toBeNull();
    await userEvent.type(passwordInput!, 'SecureP@ss123');
    await expect(passwordInput).toHaveValue('SecureP@ss123');
  },
};

/**
 * 送信中（ローディング）状態。
 *
 * signUp を永久にペンディングなPromiseに差し替えて、
 * フォーム送信後のスピナー・ボタンのdisabled状態を確認する。
 */
export const Submitting: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        signUp: fn(() => new Promise(() => undefined)),
      },
    },
  },
  play: async ({ canvasElement, parameters }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByRole('textbox', { name: /メールアドレス/ });
    await userEvent.type(emailInput, 'newuser@example.com');

    const passwordInput = canvasElement.querySelector<HTMLInputElement>('#password');
    await userEvent.type(passwordInput!, 'SecureP@ss123');

    const submitButton = canvas.getByRole('button', { name: /アカウント作成/i });
    await userEvent.click(submitButton);

    await waitFor(() =>
      expect(parameters.storeMocks.useAuthStore.signUp).toHaveBeenCalledWith(
        'newuser@example.com',
        'SecureP@ss123',
      ),
    );

    // ボタンがローディング状態になっていることを確認
    await expect(submitButton).toBeDisabled();
  },
};

/**
 * サーバーエラー表示状態。
 *
 * signUp がエラーを返すようにモックし、送信後にエラーメッセージが
 * フォーム上部に表示されることを確認する。
 */
export const ServerError: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        signUp: fn(() =>
          Promise.resolve({
            data: { user: null, session: null },
            error: { message: 'User already registered', name: 'AuthError', status: 400 },
          } as never),
        ),
      },
    },
  },
  play: async ({ canvasElement, parameters }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByRole('textbox', { name: /メールアドレス/ });
    await userEvent.type(emailInput, 'existing@example.com');

    const passwordInput = canvasElement.querySelector<HTMLInputElement>('#password');
    await userEvent.type(passwordInput!, 'SecureP@ss123');

    const submitButton = canvas.getByRole('button', { name: /アカウント作成/i });
    await userEvent.click(submitButton);

    await waitFor(() =>
      expect(parameters.storeMocks.useAuthStore.signUp).toHaveBeenCalledWith(
        'existing@example.com',
        'SecureP@ss123',
      ),
    );

    // エラーメッセージが表示されることを確認（非同期のため waitFor）
    await waitFor(() => expect(canvas.getByRole('alert')).toBeInTheDocument());
  },
};

/** エラーメッセージ一覧 */
export const ErrorMessages: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4 p-6">
      <p className="text-muted-foreground text-sm">SignupForm エラーバリエーション</p>
      <FieldError announceImmediately className="text-center">
        このメールアドレスは既に登録されています。ログインしてください。
      </FieldError>
      <FieldError announceImmediately className="text-center">
        リクエストが多すぎます。しばらく待ってから再試行してください。
      </FieldError>
      <FieldError announceImmediately className="text-center">
        パスワードは8文字以上にしてください
      </FieldError>
      <FieldError announceImmediately className="text-center">
        このパスワードは過去に漏洩しています。より安全なパスワードを使用してください。
      </FieldError>
      <FieldError announceImmediately className="text-center">
        問題が発生しました。時間をおいて再度お試しください。
      </FieldError>
    </div>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <p className="text-muted-foreground mb-2 text-xs">Default</p>
      <SignupForm />
      <p className="text-muted-foreground mb-2 text-xs">ErrorMessages</p>
      <div className="flex max-w-md flex-col gap-4 p-6">
        <FieldError announceImmediately className="text-center">
          このメールアドレスは既に登録されています。ログインしてください。
        </FieldError>
        <FieldError announceImmediately className="text-center">
          リクエストが多すぎます。しばらく待ってから再試行してください。
        </FieldError>
        <FieldError announceImmediately className="text-center">
          パスワードは8文字以上にしてください
        </FieldError>
        <FieldError announceImmediately className="text-center">
          このパスワードは過去に漏洩しています。より安全なパスワードを使用してください。
        </FieldError>
        <FieldError announceImmediately className="text-center">
          問題が発生しました。時間をおいて再度お試しください。
        </FieldError>
      </div>
    </div>
  ),
};
