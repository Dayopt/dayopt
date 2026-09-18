// @vitest-environment happy-dom

import {
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
  type BrowserTelemetryConsent,
} from '@dayopt/observability';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '../../../messages/en/common.json';

// CookieConsentBannerView が使う next-intl 由来の Link は、この vitest 環境では
// next-intl 内部の `next/navigation` 解決に失敗して import できない
// （legal-document-contract.test.tsx の冒頭コメントと同じ既知の制約）。
// ここで検証するのは同意値の読み書きと開閉なので、Link は素の anchor に差し替える。
// locale prefix の付与そのものは banner の Story と E2E 側で見る。
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { CookieConsentSettings } from './CookieConsentSettings';

const KEY = BROWSER_TELEMETRY_CONSENT_STORAGE_KEY;
const TRIGGER = messages.common.cookies.settings.trigger;
const ALLOW = messages.common.cookies.banner.allowAnalytics;
const NECESSARY_ONLY = messages.common.cookies.banner.necessaryOnly;

function storeConsent(analytics: boolean) {
  const consent: BrowserTelemetryConsent = {
    necessary: true,
    analytics,
    marketing: false,
    timestamp: 1_700_000_000_000,
  };
  window.localStorage.setItem(KEY, JSON.stringify(consent));
}

function readConsent(): BrowserTelemetryConsent | null {
  const raw = window.localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as BrowserTelemetryConsent) : null;
}

function trigger() {
  return screen.getByRole('button', { name: TRIGGER });
}

/** description は「現在の状態 + origin 注記」を 1 段落に持つので部分一致で見る。 */
function expectStatusShown(status: string) {
  expect(screen.getByText(status, { exact: false })).toBeTruthy();
}

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CookieConsentSettings />
    </NextIntlClientProvider>,
  );
}

/**
 * 常設の Cookie 設定導線 — 保存済みの選択を後から変えられることを固定する（#2831）。
 *
 * バナー（CookieConsentBanner）は「未選択なら 1 回だけ出る」ので、保存済みの利用者には
 * 再訪できる入口が無かった。この component はその入口で、保存済みでも必ず開ける。
 */
describe('CookieConsentSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('保存済みの許可があっても開けて、現在の状態を示す', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expectStatusShown(messages.common.cookies.settings.status.allowed);
  });

  it('撤回すると analytics:false が保存され、パネルが閉じる', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: NECESSARY_ONLY }));

    expect(readConsent()?.analytics).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('拒否済みからの再許可では marketing を true にしない', async () => {
    const user = userEvent.setup();
    storeConsent(false);
    renderSettings();

    await user.click(trigger());
    expectStatusShown(messages.common.cookies.settings.status.refused);

    await user.click(screen.getByRole('button', { name: ALLOW }));

    expect(readConsent()?.analytics).toBe(true);
    expect(readConsent()?.marketing).toBe(false);
  });

  it('未選択のときはその旨を示す', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(trigger());

    expectStatusShown(messages.common.cookies.settings.status.unset);
  });

  it('別タブの撤回に追従する', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    await user.click(trigger());
    expectStatusShown(messages.common.cookies.settings.status.allowed);

    storeConsent(false);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));

    expect(
      await screen.findByText(messages.common.cookies.settings.status.refused, { exact: false }),
    ).toBeTruthy();
  });

  it('localStorage が使えなくても throw せず開ける', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });

    try {
      renderSettings();
      await user.click(trigger());
      expectStatusShown(messages.common.cookies.settings.status.unset);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
