/**
 * ThemeToggle（テーマ切替）の Storybook Story。
 *
 * next-themes の useTheme を使う client component。Storybook には NextThemesProvider が
 * 無いため theme は未設定（System 表示）になる。ドロップダウンの開閉のみ確認する。
 */
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';
import { expect, userEvent, within } from 'storybook/test';
import commonJa from '../../../../messages/ja/common.json';

import { ThemeToggle } from './theme-toggle';

const meta = {
  title: 'Web/Components/Actions/ThemeToggle',
  component: ThemeToggle,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <Story />
      </NextIntlClientProvider>
    ),
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 基本状態（Provider 無しでは System アイコン表示）。 */
export const Default: Story = {};

/** ドロップダウンを開いた状態（Light / Dark / System）。 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Change theme|テーマを変更/ }));
    // Radix の Portal + animation のため toBeVisible は不安定。存在確認で開いたことを担保する
    await expect(await within(document.body).findByRole('menu')).toBeInTheDocument();
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <ThemeToggle />
    </div>
  ),
};
