/**
 * SettingsDialog Stories
 *
 * PC用設定ダイアログ。useShellStore で開閉・カテゴリを管理。
 * SettingsContent は各カテゴリコンポーネントを遅延読み込みするため、
 * tRPC モックで userSettings をカバー。
 *
 * 注意: SettingsContent は Suspense + lazy loading を使用する。
 * ローディング中はスケルトンが表示される。
 */

import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { useShellStore } from '@/lib/stores/useShellStore';
import { Button } from '@dayopt/components';
import { PRESET_AUTH, PRESET_USER_SETTINGS } from '@dayopt/storybook/mocks/presets';
import { StoryTRPCProvider } from '@dayopt/storybook/mocks/trpc';
import type { SettingsCategory } from '../types';
import { SettingsDialog } from './SettingsDialog';

// ─────────────────────────────────────────────────────────
// モックデータ
// ─────────────────────────────────────────────────────────

const MOCK_PROFILE = {
  id: 'user-1',
  email: 'user@example.com',
  fullName: 'テストユーザー',
  avatarUrl: null,
};

// ─────────────────────────────────────────────────────────
// 共通 tRPC モックマップ
// ─────────────────────────────────────────────────────────

const DIALOG_MOCKS = {
  'userSettings.get': PRESET_USER_SETTINGS.default,
  'profile.get': MOCK_PROFILE,
  'statistics.getTagStats': { counts: {} },
  'externalCalendar.getConnectionAvailability': { available: false },
  'externalCalendar.listConnections': [],
  'userSettings.getICalToken': { token: null },
};

// ─────────────────────────────────────────────────────────
// インタラクティブラッパー
// ─────────────────────────────────────────────────────────

function InteractiveSettingsDialog({
  initialCategory = 'account',
}: {
  initialCategory?: SettingsCategory;
}) {
  const [mounted, setMounted] = useState(false);

  return (
    <StoryTRPCProvider mocks={DIALOG_MOCKS}>
      <Button
        onClick={() => {
          useShellStore.getState().openSettings(initialCategory);
          setMounted(true);
        }}
      >
        設定を開く
      </Button>
      {mounted && <SettingsDialog />}
    </StoryTRPCProvider>
  );
}

// ─────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────

/**
 * SettingsDialog — 設定ダイアログ（PC用）
 *
 * useShellStore で開閉とカテゴリ切替を管理。
 * URL は変更せず、モーダル内でサイドバーのカテゴリ切替のみ行う。
 */
const meta = {
  title: 'Product/Features/Settings/SettingsDialog',
  component: SettingsDialog,
  parameters: {
    layout: 'fullscreen',
    storeMocks: { useAuthStore: PRESET_AUTH.authenticated },
    trpcMocks: DIALOG_MOCKS,
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/**
 * デフォルト状態（アカウントカテゴリ）
 *
 * ダイアログが開いた状態でアカウント設定を表示。
 * サイドバーで他カテゴリに切り替えできる。
 */
export const Default: Story = {
  render: () => {
    useShellStore.setState({ activeSheet: { type: 'settings', category: 'account' } });
    return <SettingsDialog />;
  },
};

/**
 * 表示設定カテゴリ
 */
export const DisplayCategory: Story = {
  render: () => {
    useShellStore.setState({ activeSheet: { type: 'settings', category: 'display' } });
    return <SettingsDialog />;
  },
};

/**
 * データ設定カテゴリ
 */
export const DataCategory: Story = {
  render: () => {
    useShellStore.setState({ activeSheet: { type: 'settings', category: 'data' } });
    return <SettingsDialog />;
  },
};

/**
 * 連携設定カテゴリ
 */
export const IntegrationsCategory: Story = {
  render: () => {
    useShellStore.setState({ activeSheet: { type: 'settings', category: 'integrations' } });
    return <SettingsDialog />;
  },
};

/**
 * 閉じた状態
 *
 * activeSheet が null の場合、ダイアログは表示されない。
 */
export const ClosedState: Story = {
  render: () => {
    useShellStore.setState({ activeSheet: null });
    return (
      <>
        <SettingsDialog />
        <div className="flex h-screen items-center justify-center">
          <p className="text-muted-foreground text-sm">（ダイアログは閉じています）</p>
        </div>
      </>
    );
  },
};

/**
 * ボタンクリックで開くインタラクティブモード
 *
 * 実際のユーザー操作フローを確認できる。
 */
export const Interactive: Story = {
  render: () => <InteractiveSettingsDialog />,
};

/** ダイアログを開いたまま狭いウィンドウへ変更した状態。 */
export const NarrowViewport: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  render: () => {
    useShellStore.setState({ activeSheet: { type: 'settings', category: 'account' } });
    return <SettingsDialog />;
  },
};
