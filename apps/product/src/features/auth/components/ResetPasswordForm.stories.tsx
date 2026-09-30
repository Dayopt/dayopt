import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';

import { cn, FieldError } from '@dayopt/components';

import { ResetPasswordForm } from './ResetPasswordForm';

/** ResetPasswordForm - パスワードリセットフォーム（メールリンク経由） */
const meta = {
  title: 'Product/Features/Auth/ResetPasswordForm',
  component: ResetPasswordForm,
  parameters: {
    layout: 'padded',
    nextjs: {
      navigation: {
        pathname: '/ja/auth/reset-password',
        params: { locale: 'ja' },
      },
    },
    // デフォルトのupdatePasswordはno-opに差し替える（Supabase接続不要）
    storeMocks: {
      useAuthStore: {
        updatePassword: () => new Promise(() => undefined),
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ResetPasswordForm>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト表示（フォーム状態） */
export const Default: Story = {};

/** パスワード入力の操作テスト */
export const WithInteraction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // パスワード入力
    const passwordInput = canvas.getByLabelText(/新しいパスワード/i);
    await userEvent.type(passwordInput, 'SecureP@ss123');

    // 確認パスワード入力
    const confirmInput = canvas.getByLabelText(/パスワード確認/i);
    await userEvent.type(confirmInput, 'SecureP@ss123');

    // 入力されていることを確認
    await expect(passwordInput).toHaveValue('SecureP@ss123');
    await expect(confirmInput).toHaveValue('SecureP@ss123');
  },
};

/**
 * 送信中（ローディング）状態。
 *
 * updatePassword を永久にペンディングなPromiseに差し替えて、
 * フォーム送信後のスピナー・ボタンのdisabled状態を確認する。
 */
export const Submitting: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        updatePassword: () => new Promise(() => undefined),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const passwordInput = canvas.getByLabelText(/新しいパスワード/i);
    await userEvent.type(passwordInput, 'SecureP@ss123!');

    const confirmInput = canvas.getByLabelText(/パスワード確認/i);
    await userEvent.type(confirmInput, 'SecureP@ss123!');

    const submitButton = canvas.getByRole('button', { name: /パスワードを更新/i });
    await userEvent.click(submitButton);

    // ボタンがローディング状態になっていることを確認
    await expect(submitButton).toBeDisabled();
  },
};

/**
 * エラー表示（パスワード不一致）。
 *
 * 実コンポーネントに不一致パスワードを入力して送信し、
 * クライアントサイドバリデーションエラーが表示されることを確認する。
 */
export const Error: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const passwordInput = canvas.getByLabelText(/新しいパスワード/i);
    await userEvent.type(passwordInput, 'SecureP@ss123!');

    const confirmInput = canvas.getByLabelText(/パスワード確認/i);
    await userEvent.type(confirmInput, 'DifferentPass456!');

    const submitButton = canvas.getByRole('button', { name: /パスワードを更新/i });
    await userEvent.click(submitButton);

    // パスワード不一致エラーが表示されることを確認
    await expect(canvas.getByRole('alert')).toBeInTheDocument();
  },
};

/**
 * 成功状態。
 *
 * updatePassword が成功を返すようにモックし、送信後に
 * 実コンポーネントの成功画面（チェックアイコン付き）が表示されることを確認する。
 */
export const Success: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        updatePassword: () =>
          Promise.resolve({
            data: { user: null, session: null },
            error: null,
          } as never),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const passwordInput = canvas.getByLabelText(/新しいパスワード/i);
    await userEvent.type(passwordInput, 'SecureP@ss123!');

    const confirmInput = canvas.getByLabelText(/パスワード確認/i);
    await userEvent.type(confirmInput, 'SecureP@ss123!');

    const submitButton = canvas.getByRole('button', { name: /パスワードを更新/i });
    await userEvent.click(submitButton);

    // 実コンポーネントの成功画面が表示されることを確認
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'パスワードを更新しました' }),
    ).toBeInTheDocument();
  },
};

/**
 * サーバーエラー表示状態。
 *
 * updatePassword がエラーを返すようにモックし、送信後にサーバーエラーメッセージが
 * フォーム上部に表示されることを確認する。
 */
export const ServerError: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        updatePassword: () =>
          Promise.resolve({
            data: { user: null, session: null },
            error: { message: 'Password update failed', name: 'AuthError', status: 422 },
          } as never),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const passwordInput = canvas.getByLabelText(/新しいパスワード/i);
    await userEvent.type(passwordInput, 'SecureP@ss123!');

    const confirmInput = canvas.getByLabelText(/パスワード確認/i);
    await userEvent.type(confirmInput, 'SecureP@ss123!');

    const submitButton = canvas.getByRole('button', { name: /パスワードを更新/i });
    await userEvent.click(submitButton);

    // エラーメッセージが表示されることを確認
    await expect(canvas.getByRole('alert')).toBeInTheDocument();
  },
};

/** エラーメッセージ一覧 */
export const ErrorMessages: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4 p-6">
      <p className="text-muted-foreground text-sm">ResetPasswordForm エラーバリエーション</p>
      <FieldError announceImmediately className="text-center">
        パスワードが一致しません
      </FieldError>
      <FieldError announceImmediately className="text-center">
        パスワードは8文字以上である必要があります
      </FieldError>
      <FieldError announceImmediately className="text-center">
        問題が発生しました。時間をおいて再度お試しください。
      </FieldError>
    </div>
  ),
};

/** 全パターン */
export const AllPatterns: Story = {
  render: () => (
    <div className={cn('flex flex-col items-start gap-8')}>
      <div>
        <p className="text-muted-foreground mb-2 text-sm">Default</p>
        <ResetPasswordForm />
      </div>
    </div>
  ),
};
