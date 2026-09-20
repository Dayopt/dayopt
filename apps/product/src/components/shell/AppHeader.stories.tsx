import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AppHeader } from '@/components/shell/AppHeader';

// ─────────────────────────────────────────────────────────
// Stub UI Helpers
// ─────────────────────────────────────────────────────────

/** 左スロットのスタブ（MobileFilterButton等の代替） */
function StubLeftSlot() {
  return (
    <button
      type="button"
      className="border-border bg-container hover:bg-state-hover rounded-lg border px-2 py-1 text-xs"
    >
      フィルタ
    </button>
  );
}

/** 右スロットのスタブ */
function StubRightSlot() {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="border-border bg-container hover:bg-state-hover rounded-lg border px-2 py-1 text-xs"
      >
        週
      </button>
      <button
        type="button"
        className="border-border bg-container hover:bg-state-hover rounded-lg border px-2 py-1 text-xs"
      >
        月
      </button>
    </div>
  );
}

/** AppHeader - アプリ共通ヘッダーシェル */
const meta = {
  title: 'Product/Components/Shell/AppHeader',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** タイトル表示（通常ページ） */
export const Default: Story = {
  render: () => (
    <div className="border-border w-full border">
      <AppHeader>
        <h1 className="truncate text-lg leading-8 font-medium">Plans</h1>
      </AppHeader>
    </div>
  ),
};

/** モバイル表示。viewport addon で md:hidden / hidden md:flex が自動切替。 */
export const Mobile: Story = {
  render: () => (
    <div className="border-border w-full border">
      <AppHeader leftSlot={<StubLeftSlot />}>
        <h1 className="truncate text-lg leading-8 font-medium">Plans</h1>
      </AppHeader>
    </div>
  ),
  globals: {
    viewport: { value: 'mobile1' },
  },
};

/**
 * leftSlot + rightSlot パターン
 *
 * モバイルではleftSlotにフィルターボタン等、
 * デスクトップではrightSlotにコントロール群を配置。
 */
export const WithSlots: Story = {
  render: () => (
    <div className="border-border w-full border">
      <AppHeader leftSlot={<StubLeftSlot />} rightSlot={<StubRightSlot />}>
        <h1 className="truncate text-lg leading-8 font-medium">カレンダー</h1>
      </AppHeader>
    </div>
  ),
};

/** rightSlotのみ */
export const WithRightSlot: Story = {
  render: () => (
    <div className="border-border w-full border">
      <AppHeader rightSlot={<StubRightSlot />}>
        <h1 className="truncate text-lg leading-8 font-medium">カレンダー</h1>
      </AppHeader>
    </div>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <article className="border-border w-full border">
        <AppHeader>
          <h1 className="truncate text-lg leading-8 font-medium">タイトルのみ</h1>
        </AppHeader>
      </article>
      <article className="border-border w-full border">
        <AppHeader leftSlot={<StubLeftSlot />}>
          <h1 className="truncate text-lg leading-8 font-medium">leftSlot付き</h1>
        </AppHeader>
      </article>
      <article className="border-border w-full border">
        <AppHeader rightSlot={<StubRightSlot />}>
          <h1 className="truncate text-lg leading-8 font-medium">rightSlot付き</h1>
        </AppHeader>
      </article>
      <article className="border-border w-full border">
        <AppHeader leftSlot={<StubLeftSlot />} rightSlot={<StubRightSlot />}>
          <h1 className="truncate text-lg leading-8 font-medium">全スロット</h1>
        </AppHeader>
      </article>
    </div>
  ),
};
