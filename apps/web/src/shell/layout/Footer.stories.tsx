/**
 * Footer（サイト共通フッター）の Storybook Story。
 *
 * Footer の静的な部分は server、ThemeToggle / LanguageSwitcher は client。
 * story では同じ表示を NextIntlClientProvider で
 * self-provide し、common namespace と footer namespace を含む common.json を渡す。
 * locale 駆動なので ja / en。
 */
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';

import commonEn from '../../../messages/en/common.json';
import commonJa from '../../../messages/ja/common.json';

import { Footer } from './Footer';

const meta = {
  title: 'Web/Components/Shell/Footer',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** 日本語ロケール。 */
export const Ja: Story = {
  render: () => (
    <NextIntlClientProvider locale="ja" messages={commonJa}>
      <Footer />
    </NextIntlClientProvider>
  ),
};

/** 英語ロケール。 */
export const En: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={commonEn}>
      <Footer />
    </NextIntlClientProvider>
  ),
};

/** 全ロケール一覧。 */
export const AllPatterns: Story = {
  parameters: {
    a11y: {
      options: {
        // カタログ表示のため ja/en の Footer を2つ並べており、実ページでは
        // footer（contentinfo landmark）は1つのみ描画されるため誤検知
        rules: {
          'landmark-no-duplicate-contentinfo': { enabled: false },
          'landmark-unique': { enabled: false },
        },
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8">
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <Footer />
      </NextIntlClientProvider>
      <NextIntlClientProvider locale="en" messages={commonEn}>
        <Footer />
      </NextIntlClientProvider>
    </div>
  ),
};
