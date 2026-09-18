// @vitest-environment happy-dom

import {
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
  type BrowserTelemetryConsent,
} from '@dayopt/observability';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

import { CookieConsentBanner } from './CookieConsentBanner';
import { CookieConsentSettings } from './CookieConsentSettings';

const KEY = BROWSER_TELEMETRY_CONSENT_STORAGE_KEY;
const TRIGGER = messages.common.cookies.settings.trigger;
const ALLOW = messages.common.cookies.banner.allowAnalytics;
const NECESSARY_ONLY = messages.common.cookies.banner.necessaryOnly;
const REVOKE_CONFIRM = messages.common.cookies.settings.revokeConfirmLabel;
const REVOKE_CANCEL = messages.common.cookies.settings.revokeCancelLabel;
const BANNER_TITLE = messages.common.cookies.banner.title;

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

  it('許可済みからの撤回は確認を経てから保存し、パネルが閉じる', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: NECESSARY_ONLY }));

    // production では撤回で instrumentation-client がページを再読み込みするため、
    // 未送信の入力が消えることを先に伝える。この時点では保存していない。
    expect(
      screen.getByText(messages.common.cookies.settings.revokeConfirmDescription),
    ).toBeTruthy();
    expect(readConsent()?.analytics).toBe(true);

    await user.click(screen.getByRole('button', { name: REVOKE_CONFIRM }));

    expect(readConsent()?.analytics).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('撤回の確認をキャンセルすると許可のまま選択画面へ戻る', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: NECESSARY_ONLY }));
    await user.click(screen.getByRole('button', { name: REVOKE_CANCEL }));

    expect(readConsent()?.analytics).toBe(true);
    expectStatusShown(messages.common.cookies.settings.status.allowed);
  });

  it('保存だけが失敗する環境では閉じず、保存できなかったことを伝える', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    renderSettings();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: NECESSARY_ONLY }));

    // 容量超過などで「読めるが書けない」状態。persistBrowserTelemetryConsent は
    // 例外を握りつぶすので、呼べたこと自体を成功の根拠にできない。
    const realStorage = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({
        getItem: (key: string) => realStorage.getItem(key),
        setItem: () => {
          throw new DOMException('quota', 'QuotaExceededError');
        },
        removeItem: () => {
          throw new DOMException('quota', 'QuotaExceededError');
        },
      }),
    });

    try {
      await user.click(screen.getByRole('button', { name: REVOKE_CONFIRM }));

      expect(screen.getByRole('alert').textContent).toBe(
        messages.common.cookies.settings.saveFailed,
      );
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }

    expect(readConsent()?.analytics).toBe(true);
  });

  it('初回バナーと同時に出ているとき、設定側で選ぶとバナーも閉じる', () => {
    vi.useFakeTimers();
    // requestIdleCallback の有無は環境依存なので fallback の setTimeout 経路に固定する。
    const idleDescriptor = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');

    try {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <CookieConsentBanner />
          <CookieConsentSettings />
        </NextIntlClientProvider>,
      );

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(screen.getByRole('heading', { name: BANNER_TITLE })).toBeTruthy();

      // footer 側の設定から選ぶ（バナー自身の onClick は通らない経路）。
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: TRIGGER }));
      });
      act(() => {
        fireEvent.click(screen.getAllByRole('button', { name: ALLOW })[0]!);
      });

      expect(readConsent()?.analytics).toBe(true);
      expect(screen.queryByRole('heading', { name: BANNER_TITLE })).toBeNull();
    } finally {
      vi.useRealTimers();
      if (idleDescriptor) Object.defineProperty(window, 'requestIdleCallback', idleDescriptor);
    }
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
