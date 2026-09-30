/**
 * AccountSettings Stories
 *
 * MFASection は Supabase Auth MFA API を直接呼ぶため tRPC でモック不可。
 * `_MFASectionProps` 経由で `_useMFAHook` を差し替えることで
 * MFA 各状態を実コンポーネントのまま描画する。
 *
 * `_useMFAHook` は関数 prop のため Storybook の args 型推論対象外。
 * `satisfies Meta`（型引数なし）を使い、render 関数内で直接 prop を渡す。
 *
 * useAuthStore のみ setState でモック（Supabase Auth 不要）。
 */

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { PRESET_AUTH } from '@dayopt/storybook/mocks/presets';

import type { UseMFAReturn } from '../hooks/useMFA';
import { AccountSettings } from './AccountSettings';

// ─────────────────────────────────────────────────────────
// モックファクトリ
// ─────────────────────────────────────────────────────────

/**
 * useMFA フックのモック返却値を生成するヘルパー。
 * MFASection.stories.tsx の createMockMFA と同じパターン。
 */
function createMockMFA(overrides: Partial<UseMFAReturn> = {}): UseMFAReturn {
  return {
    hasMFA: false,
    showMFASetup: false,
    qrCode: null,
    secret: null,
    factorId: null,
    verificationCode: '',
    error: null,
    success: null,
    isLoading: false,
    recoveryCodes: null,
    recoveryCodeCount: 0,
    showDisableDialog: false,
    showRegenerateDialog: false,
    setVerificationCode: fn(),
    enrollMFA: fn(),
    verifyMFA: fn(),
    requestDisableMFA: fn(),
    confirmDisableMFA: fn(),
    cancelDisableMFA: fn(),
    cancelSetup: fn(),
    requestRegenerateRecoveryCodes: fn(),
    confirmRegenerateRecoveryCodes: fn(),
    cancelRegenerateRecoveryCodes: fn(),
    dismissRecoveryCodes: fn(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────

/**
 * `_MFASectionProps._useMFAHook` は関数 prop のため Storybook の args 型推論対象外。
 * `satisfies Meta`（型引数なし）を使い、render 関数内で直接 prop を渡す。
 */
const meta = {
  title: 'Product/Features/Settings/AccountSettings',
  component: AccountSettings,
  parameters: {
    layout: 'padded',
    storeMocks: { useAuthStore: PRESET_AUTH.authenticated },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト表示。MFA未設定状態（「有効にする」ボタン表示）。 */
export const Default: Story = {
  render: () => <AccountSettings _MFASectionProps={{ _useMFAHook: () => createMockMFA() }} />,
};

/**
 * Google でのみ登録したユーザー。パスワードを持たないため、
 * 「ログイン方法: Google」が出て、メールは変更不可の表示になり、
 * パスワードのセクションごと消えることを確認できる。
 */
export const GoogleAccount: Story = {
  parameters: {
    storeMocks: { useAuthStore: PRESET_AUTH.googleOnly },
  },
  render: () => <AccountSettings _MFASectionProps={{ _useMFAHook: () => createMockMFA() }} />,
};

/**
 * メールアドレス未設定のユーザー。
 * メール行のラベルが空欄になることを確認できる。
 */
export const NoEmail: Story = {
  parameters: {
    storeMocks: { useAuthStore: PRESET_AUTH.noEmail },
  },
  render: () => <AccountSettings _MFASectionProps={{ _useMFAHook: () => createMockMFA() }} />,
};

/** MFA有効済み状態。リカバリーコード残り8個。 */
export const MFAEnabled: Story = {
  render: () => (
    <AccountSettings
      _MFASectionProps={{
        _useMFAHook: () => createMockMFA({ hasMFA: true, recoveryCodeCount: 8 }),
      }}
    />
  ),
};

/** MFA有効済み、リカバリーコード枯渇（0個）。destructive 警告を表示。 */
export const MFAEnabledExhausted: Story = {
  render: () => (
    <AccountSettings
      _MFASectionProps={{
        _useMFAHook: () => createMockMFA({ hasMFA: true, recoveryCodeCount: 0 }),
      }}
    />
  ),
};

/** MFA登録中（QRコード表示）状態。 */
export const MFASetup: Story = {
  render: () => (
    <AccountSettings
      _MFASectionProps={{
        _useMFAHook: () =>
          createMockMFA({
            showMFASetup: true,
            // 1x1 透明PNG（QRコードのプレースホルダー）
            qrCode:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            secret: 'JBSWY3DPEHPK3PXP',
            factorId: 'factor-demo-id',
          }),
      }}
    />
  ),
};

/** MFA有効化直後のリカバリーコード表示。 */
export const MFARecoveryCodes: Story = {
  render: () => (
    <AccountSettings
      _MFASectionProps={{
        _useMFAHook: () =>
          createMockMFA({
            hasMFA: true,
            recoveryCodeCount: 10,
            success: '多要素認証が有効になりました',
            recoveryCodes: [
              'ABCD-EF23',
              'GHJK-LM45',
              'NPQR-ST67',
              'UVWX-YZ89',
              'AB23-CD45',
              'EF67-GH89',
              'JK23-LM45',
              'NP67-QR89',
              'ST23-UV45',
              'WX67-YZ89',
            ],
          }),
      }}
    />
  ),
};

/** アカウント設定をプロフィール・セキュリティ・セッションごとに表示。 */
export const AllPatterns: Story = {
  render: () => <AccountSettings _MFASectionProps={{ _useMFAHook: () => createMockMFA() }} />,
};
