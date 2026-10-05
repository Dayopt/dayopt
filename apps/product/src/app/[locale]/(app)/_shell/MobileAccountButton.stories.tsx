import { Redo2 } from 'lucide-react';

import { Button } from '@dayopt/components';

import { MobileAccountButton } from './MobileAccountButton';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const meta = {
  title: 'Product/Components/Shell/MobileAccountButton',
  component: MobileAccountButton,
  parameters: {
    layout: 'centered',
    viewport: { defaultViewport: 'mobile1' },
  },
  tags: ['autodocs'],
  args: {
    href: '/ja/settings',
    displayName: 'Tomoya Tanaka',
    ariaLabel: 'アカウント',
  },
} satisfies Meta<typeof MobileAccountButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** アバター画像なしの標準状態。 */
export const Default: Story = {};

/** アバター画像がある状態。 */
export const WithAvatar: Story = {
  args: {
    avatarUrl: 'https://github.com/shadcn.png',
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <MobileAccountButton href="/ja/settings" displayName="Tomoya Tanaka" ariaLabel="アカウント" />
      <MobileAccountButton
        href="/ja/settings"
        displayName="Tomoya Tanaka"
        avatarUrl="https://github.com/shadcn.png"
        ariaLabel="アカウント"
      />
    </div>
  ),
};

/**
 * モバイルカレンダーヘッダー右端の並び。
 *
 * ここが**この component の主戦場**なのに、長らく単体でしか story が無く、隣に並ぶ
 * アイコンとの釣り合いを誰も見ていなかった。2026-09-07 に「アバターだけ 32px で箱を
 * 埋め切っていて大きすぎる」と実機で指摘され、24px へ落として揃えた。
 * 崩れたらここで気づけるように、実際の並びを固定で置く。
 */
export const InHeaderCluster: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-1">
      <Button variant="ghost" icon size="sm" className="text-muted-foreground" aria-label="今日へ">
        <Redo2 className="size-5" />
      </Button>
      <MobileAccountButton href="/ja/settings" displayName="Tomoya Tanaka" ariaLabel="アカウント" />
    </div>
  ),
};
