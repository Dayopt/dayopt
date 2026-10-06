/**
 * ThemeToggle（テーマ切替）の Storybook Story。
 *
 * ネイティブ select で Light / Dark / System を選ぶ。実際の ThemeProvider で
 * 選択による状態の変化も確認する。
 */
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ThemeProvider } from '@web/shell/providers/theme-provider';
import { NextIntlClientProvider } from 'next-intl';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
        <ThemeProvider>
          <Story />
        </ThemeProvider>
      </NextIntlClientProvider>
    ),
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** OS の設定に従う基本状態。 */
export const Default: Story = {};

/** ネイティブコントロールからテーマを変更する。 */
export const Change: Story = {
  play: async ({ canvasElement, parameters }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole('combobox', { name: commonJa.common.aria.changeTheme });
    await userEvent.selectOptions(select, 'light');
    await expect(select).toHaveValue('light');
    await userEvent.selectOptions(select, 'dark');
    await expect(select).toHaveValue('dark');
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    // 各テーマの検査を終えた後、実行環境のテーマを戻す。
    const testTheme = parameters.testTheme || 'light';
    await userEvent.selectOptions(select, testTheme);
    await waitFor(() => expect(document.documentElement).toHaveClass(testTheme));
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
