/**
 * CookieConsentSettings（常設の Cookie 設定導線）の Story。
 *
 * 保存済みの同意は localStorage が正本なので、各 Story の decorator で状態を仕込む。
 * 初回バナー（CookieConsentBanner.stories.tsx）は presentational な View を直接
 * 描画するが、ここは「保存済みでも開ける」ことが本体なので container を描画する。
 */
import { BROWSER_TELEMETRY_CONSENT_STORAGE_KEY } from '@dayopt/observability';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';

import commonEn from '../../../messages/en/common.json';
import commonJa from '../../../messages/ja/common.json';

import { CookieConsentSettings } from './CookieConsentSettings';

function seedConsent(analytics: boolean | null) {
  if (typeof window === 'undefined') return;

  try {
    if (analytics === null) {
      window.localStorage.removeItem(BROWSER_TELEMETRY_CONSENT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify({ necessary: true, analytics, marketing: false, timestamp: Date.now() }),
    );
  } catch {
    // Story の表示は同意が読めない場合（privacy mode 相当）も「未選択」で成立する。
  }
}

const meta = {
  title: 'Web/Components/Privacy/CookieConsentSettings',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** 分析を許可済み（撤回できる状態）。 */
export const Allowed: Story = {
  render: () => {
    seedConsent(true);
    return (
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <CookieConsentSettings />
      </NextIntlClientProvider>
    );
  },
};

/** 分析を拒否済み（再許可できる状態）。 */
export const Refused: Story = {
  render: () => {
    seedConsent(false);
    return (
      <NextIntlClientProvider locale="ja" messages={commonJa}>
        <CookieConsentSettings />
      </NextIntlClientProvider>
    );
  },
};

/** 未選択（初回バナーと同じ状態）。英語ロケール。 */
export const UnsetEn: Story = {
  render: () => {
    seedConsent(null);
    return (
      <NextIntlClientProvider locale="en" messages={commonEn}>
        <CookieConsentSettings />
      </NextIntlClientProvider>
    );
  },
};
