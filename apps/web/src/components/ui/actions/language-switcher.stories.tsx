/**
 * LanguageSwitcher（言語切替）の Storybook Story。
 *
 * useLocale を使う client component。decorator の NextIntlClientProvider（locale=ja）から
 * 現在ロケールを取得するため、現在表示は JA / 日本語 になる。variant で短縮/フルを切替える。
 */
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';

import commonJa from '../../../../messages/ja/common.json';

import { LanguageSwitcher } from './language-switcher';

const meta = {
  title: 'Web/Components/Actions/LanguageSwitcher',
  component: LanguageSwitcher,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <Story />
      </NextIntlClientProvider>
    ),
  ],
} satisfies Meta<typeof LanguageSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 短縮表示（EN / JA）。 */
export const Short: Story = {
  args: { variant: 'short' },
};

/** フル表示（English / 日本語）。 */
export const Full: Story = {
  args: { variant: 'full' },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <LanguageSwitcher variant="short" />
      <LanguageSwitcher variant="full" />
    </div>
  ),
};
