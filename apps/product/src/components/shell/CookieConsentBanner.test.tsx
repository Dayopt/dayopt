import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
} from '@dayopt/observability';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/ja/calendar',
}));

import { CookieConsentBanner } from './CookieConsentBanner';

const CONSENT_KEY = BROWSER_TELEMETRY_CONSENT_STORAGE_KEY;
const BANNER_TITLE = 'common.cookies.banner.title';

function storeConsent(analytics: boolean) {
  window.localStorage.setItem(
    CONSENT_KEY,
    JSON.stringify({ necessary: true, analytics, marketing: false, timestamp: 1 }),
  );
}

/**
 * 初回バナーは同意の変化に追従する（#2831）。
 *
 * バナーは未選択のときだけ出るが、設定（データ設定の分析同意セクション）や別タブで
 * 選択が確定したときに閉じないと、保存済みなのに同じ質問を出し続けることになる。
 */
describe('CookieConsentBanner が別導線の選択に追従する', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    // requestIdleCallback の有無は環境依存なので、fallback の setTimeout 経路に固定する。
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('未選択なら遅延表示される', () => {
    render(<CookieConsentBanner />);
    expect(screen.queryByText(BANNER_TITLE)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();
  });

  it('同一文書の別導線で選択が確定したら閉じる', () => {
    render(<CookieConsentBanner />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();

    // 設定セクションの保存と同じ経路（保存 → cookieConsentChanged）。
    act(() => {
      storeConsent(false);
      window.dispatchEvent(
        new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, {
          detail: { necessary: true, analytics: false, marketing: false, timestamp: 1 },
        }),
      );
    });

    expect(screen.queryByText(BANNER_TITLE)).toBeNull();
  });

  it('別タブで選択が確定したら閉じる', () => {
    render(<CookieConsentBanner />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();

    act(() => {
      storeConsent(true);
      window.dispatchEvent(new StorageEvent('storage', { key: CONSENT_KEY }));
    });

    expect(screen.queryByText(BANNER_TITLE)).toBeNull();
  });
});
