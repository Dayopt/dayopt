'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  isBrowserTelemetryConsentStorageChange,
} from '@dayopt/observability';
import { useEffect, useState } from 'react';

import {
  needsBrowserTelemetryConsent,
  persistBrowserTelemetryConsent,
} from '@web/platform/privacy/browser-telemetry-consent';

import { CookieConsentBannerView } from './CookieConsentBannerView';
import type { CookieConsentBannerCopy } from './cookie-consent-copy';

/** Ask once before enabling browser error monitoring or analytics. */
export function CookieConsentBannerClient({ copy }: { copy: CookieConsentBannerCopy }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const checkConsent = () => setVisible(needsBrowserTelemetryConsent());
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    // footer の常設 Cookie 設定や別タブで選択が確定したら、同じ質問を繰り返さない
    // ようバナーを閉じる。逆に未選択へ戻れば再び出す。
    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
      checkConsent();
    };

    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, checkConsent);
    window.addEventListener('storage', handleStorage);

    let cancelInitialCheck: () => void;
    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const handle = idleWindow.requestIdleCallback(checkConsent, { timeout: 2000 });
      cancelInitialCheck = () => idleWindow.cancelIdleCallback?.(handle);
    } else {
      const timer = globalThis.setTimeout(checkConsent, 1000);
      cancelInitialCheck = () => globalThis.clearTimeout(timer);
    }

    return () => {
      cancelInitialCheck();
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, checkConsent);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const chooseConsent = (analytics: boolean) => {
    persistBrowserTelemetryConsent(analytics);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <CookieConsentBannerView
      title={copy.title}
      description={copy.description}
      learnMoreLabel={copy.learnMoreLabel}
      learnMoreHref={copy.learnMoreHref}
      necessaryOnlyLabel={copy.necessaryOnlyLabel}
      allowAnalyticsLabel={copy.allowAnalyticsLabel}
      onNecessaryOnly={() => chooseConsent(false)}
      onAllowAnalytics={() => chooseConsent(true)}
    />
  );
}
