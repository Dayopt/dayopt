import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';

import { FieldError } from '@dayopt/components';

import { PasswordResetForm } from './PasswordResetForm';

/** PasswordResetForm - パスワードリセット依頼フォーム */
const meta = {
  title: 'Product/Features/Auth/PasswordResetForm',
  component: PasswordResetForm,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PasswordResetForm>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト表示 */
export const Default: Story = {};

/** メール入力の操作テスト */
export const WithInteraction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByLabelText(/メールアドレス/i);
    await userEvent.type(emailInput, 'forgot@example.com');
    await expect(emailInput).toHaveValue('forgot@example.com');
  },
};

/**
 * 送信中（ローディング）状態。
 *
 * resetPassword を永久にペンディングなPromiseに差し替えて、
 * フォーム送信後のスピナー・ボタンのdisabled状態を確認する。
 */
export const Submitting: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        resetPassword: () => new Promise(() => undefined),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByLabelText(/メールアドレス/i);
    await userEvent.type(emailInput, 'forgot@example.com');

    const submitButton = canvas.getByRole('button', { name: /リセット用リンクを送信/i });
    await userEvent.click(submitButton);

    // ボタンがローディング状態になっていることを確認
    await expect(submitButton).toBeDisabled();
  },
};

/**
 * リセットリンク送信完了。
 *
 * resetPassword が成功を返すようにモックし、送信後に
 * 実コンポーネントの成功画面（日本語テキスト）が表示されることを確認する。
 */
export const Success: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        resetPassword: () => Promise.resolve({ error: null } as never),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByLabelText(/メールアドレス/i);
    await userEvent.type(emailInput, 'user@example.com');

    const submitButton = canvas.getByRole('button', { name: /リセット用リンクを送信/i });
    await userEvent.click(submitButton);

    // 実コンポーネントの成功画面が表示されることを確認
    await expect(canvas.getByRole('heading', { level: 1 })).toBeInTheDocument();
  },
};

/**
 * captcha 失敗のエラー表示。
 *
 * 本人が解き直せば解決するので、これだけはエラーとして伝える。
 */
export const CaptchaError: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        resetPassword: () =>
          Promise.resolve({
            error: {
              message: 'captcha protection: request disallowed',
              code: 'captcha_failed',
              name: 'AuthError',
              status: 400,
            },
          } as never),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByLabelText(/メールアドレス/i);
    await userEvent.type(emailInput, 'forgot@example.com');

    const submitButton = canvas.getByRole('button', { name: /リセット用リンクを送信/i });
    await userEvent.click(submitButton);

    // エラーメッセージが表示されることを確認
    await expect(canvas.getByRole('alert')).toBeInTheDocument();
  },
};

/**
 * 再送間隔の 429 でも成功画面を出す（ユーザー列挙の防止）。
 *
 * 未登録アドレスは GoTrue が 200 を返す一方、登録済みアドレスは再送間隔で 429 に
 * なりうる。画面が分かれると、その差自体がアカウント存在の確認手段になる。
 */
export const RateLimitedShowsSuccess: Story = {
  parameters: {
    storeMocks: {
      useAuthStore: {
        resetPassword: () =>
          Promise.resolve({
            error: {
              message: 'For security purposes, you can only request this after 47 seconds.',
              code: 'over_email_send_rate_limit',
              name: 'AuthError',
              status: 429,
            },
          } as never),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const emailInput = canvas.getByLabelText(/メールアドレス/i);
    await userEvent.type(emailInput, 'forgot@example.com');

    const submitButton = canvas.getByRole('button', { name: /リセット用リンクを送信/i });
    await userEvent.click(submitButton);

    // 成功と同じ画面になる（エラー表示は出ない）
    await expect(canvas.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/** エラーメッセージ一覧 */
export const ErrorMessages: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4 p-6">
      <p className="text-muted-foreground text-sm">PasswordResetForm エラーバリエーション</p>
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
      <PasswordResetForm />
      <p className="text-muted-foreground mb-2 text-xs">ErrorMessages</p>
      <div className="flex max-w-md flex-col gap-4 p-6">
        <FieldError announceImmediately className="text-center">
          問題が発生しました。時間をおいて再度お試しください。
        </FieldError>
      </div>
    </div>
  ),
};
