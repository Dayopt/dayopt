import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';

import commonEn from '../../../messages/en/common.json';
import commonJa from '../../../messages/ja/common.json';
import { PageLoading } from './PageLoading';

const meta = {
  title: 'Web/Components/Shell/PageLoading',
  component: PageLoading,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <Story />
      </NextIntlClientProvider>
    ),
  ],
} satisfies Meta<typeof PageLoading>;
export default meta;
type Story = StoryObj<typeof meta>;

/** コンテンツページの読み込み中の表示。 */
export const AllPatterns: Story = {};

/** 英語の読み込み中の表示。 */
export const English: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={commonEn}>
      <PageLoading />
    </NextIntlClientProvider>
  ),
};
