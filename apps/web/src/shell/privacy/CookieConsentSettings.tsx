'use client';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  type BrowserTelemetryConsent,
  getBrowserTelemetryConsentStorage,
  isBrowserTelemetryConsentStorageChange,
  readBrowserTelemetryConsent,
} from '@dayopt/observability';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { persistBrowserTelemetryConsent } from '@web/platform/privacy/browser-telemetry-consent';

import { CookieConsentBannerView } from './CookieConsentBanner';

/**
 * 常設の Cookie 設定導線（#2831）
 *
 * 初回バナー（CookieConsentBanner）は「未選択のときに 1 回だけ」出るため、一度選んだ
 * 利用者には選び直す入口が無く、公開原稿の「分析への同意で計測を制御できる」という
 * 約束を満たせていなかった。footer に常設で置き、保存済みでも必ず開けるようにする。
 *
 * 保存形式と購読側（BrowserTelemetry / instrumentation-client）は変えない。撤回は
 * `persistBrowserTelemetryConsent(false)` で、他タブへは storage event で伝わる。
 * production では instrumentation-client が Sentry を止めるためページを再読み込みする。
 */
export function CookieConsentSettings() {
  const t = useTranslations('common.cookies');
  const [isOpen, setIsOpen] = useState(false);
  const [consent, setConsent] = useState<BrowserTelemetryConsent | null>(null);

  useEffect(() => {
    // event の detail は信用せず保存値を読み直す（reset は detail: null で飛ぶ）。
    const sync = () => setConsent(readBrowserTelemetryConsent(getBrowserTelemetryConsentStorage()));
    sync();

    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
      sync();
    };

    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, sync);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, sync);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const chooseConsent = (analytics: boolean) => {
    persistBrowserTelemetryConsent(analytics);
    setConsent(readBrowserTelemetryConsent(getBrowserTelemetryConsentStorage()));
    setIsOpen(false);
  };

  const status =
    consent === null
      ? t('settings.status.unset')
      : consent.analytics
        ? t('settings.status.allowed')
        : t('settings.status.refused');

  return (
    <>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls="cookie-consent-settings-title"
        onClick={() => setIsOpen((open) => !open)}
        className="text-muted-foreground hover:text-foreground min-h-11 text-left text-sm transition-colors hover:underline"
      >
        {t('settings.trigger')}
      </button>
      {isOpen && (
        <CookieConsentBannerView
          idPrefix="cookie-consent-settings"
          title={t('settings.title')}
          description={`${status} ${t('settings.independentOrigins')}`}
          learnMoreLabel={t('banner.learnMore')}
          necessaryOnlyLabel={t('banner.necessaryOnly')}
          allowAnalyticsLabel={t('banner.allowAnalytics')}
          onNecessaryOnly={() => chooseConsent(false)}
          onAllowAnalytics={() => chooseConsent(true)}
        />
      )}
    </>
  );
}
