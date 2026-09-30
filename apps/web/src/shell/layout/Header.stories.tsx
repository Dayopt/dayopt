/**
 * Header（サイト共通ヘッダー）の Storybook Story。
 *
 * Header は 'use client' + useTranslations('common') の client component。
 * Storybook の共有 decorator は空メッセージのため、story 内で NextIntlClientProvider を
 * self-provide して web の common.json（common namespace）を渡す。locale 駆動なので ja / en。
 */
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import commonEn from '../../../messages/en/common.json';
import commonJa from '../../../messages/ja/common.json';

import { Header } from './Header';

const meta = {
  title: 'Web/Components/Shell/Header',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** 日本語ロケール。 */
export const Ja: Story = {
  render: () => (
    <NextIntlClientProvider locale="ja" messages={commonJa}>
      <Header />
    </NextIntlClientProvider>
  ),
};

/** 英語ロケール。 */
export const En: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={commonEn}>
      <Header />
    </NextIntlClientProvider>
  ),
};

/** モバイル幅でハンバーガーメニューを開いた状態。 */
export const MobileMenu: Story = {
  parameters: { viewport: { value: 'mobile1' } },
  render: () => (
    <NextIntlClientProvider locale="ja" messages={commonJa}>
      <Header />
    </NextIntlClientProvider>
  ),
  play: async ({ canvasElement }) => {
    // lg:hidden の Tailwind breakpoint を実際に発火させるため、テスト用 iframe を
    // モバイル幅にリサイズする（addon-viewport 未導入のため parameters.viewport は効かない）。
    // vitest/browser は Vitest Browser Mode 専用で、通常の Storybook（pnpm storybook /
    // build-storybook）からは import できずモジュール読み込み自体が失敗するため、
    // 動的 import + try/catch でガードし test-storybook 実行時のみリサイズする
    try {
      const { page } = await import('vitest/browser');
      await page.viewport(320, 568);
    } catch {
      // 通常の Storybook では viewport をリサイズできないため、実ブラウザ幅に委ねる
    }
    const canvas = within(canvasElement);
    const openButton = await canvas.findByRole('button', { name: 'メニューを開く' });
    const logo = canvas.getByRole('link', { name: 'Dayopt' }).getBoundingClientRect();
    const signup = canvas.getByRole('link', { name: commonJa.common.actions.signup });
    await expect(signup).toBeVisible();
    await expect(logo.right).toBeLessThan(signup.getBoundingClientRect().left);
    await userEvent.click(openButton);
    // メニューは Radix Portal で document.body 直下に開く
    const dialog = await within(document.body).findByRole('dialog', {}, { timeout: 5000 });
    await expect(dialog).toBeVisible();
    const close = within(dialog).getByRole('button', { name: commonJa.common.aria.closeMenu });
    await userEvent.click(close);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(openButton).toHaveFocus());
  },
};

/** 全ロケール一覧。 */
export const AllPatterns: Story = {
  parameters: {
    a11y: {
      options: {
        // カタログ表示のため ja/en の Header を2つ並べており、実ページでは
        // header（banner landmark）は1つのみ描画されるため誤検知
        rules: {
          'landmark-no-duplicate-banner': { enabled: false },
          'landmark-unique': { enabled: false },
        },
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8">
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <Header />
      </NextIntlClientProvider>
      <NextIntlClientProvider locale="en" messages={commonEn}>
        <Header />
      </NextIntlClientProvider>
    </div>
  ),
};
