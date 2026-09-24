'use client';

import { Button } from '@dayopt/components';
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
 *
 * 許可済みからの撤回だけは確認を挟む。production では `instrumentation-client` が
 * Sentry を止めるためページを再読み込みし、footer は `/contact` にも出るので、
 * 入力途中のフォームが警告なしに消えるのを避ける。
 */
export function CookieConsentSettings() {
  const t = useTranslations('common.cookies');
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirmingRevoke, setIsConfirmingRevoke] = useState(false);
  const [hasSaveFailed, setHasSaveFailed] = useState(false);
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

  const closePanel = () => {
    setIsOpen(false);
    setIsConfirmingRevoke(false);
    setHasSaveFailed(false);
  };

  /**
   * 同意を書き、**保存値を読み直して意図どおりになったときだけ true を返す**。
   *
   * `persistBrowserTelemetryConsent` は localStorage の書き込み失敗を握りつぶすため、
   * 容量超過などで「読めるが書けない」環境では拒否したつもりで許可が残り、telemetry も
   * 止まらない。成功を推定せず実際の保存値で判定する。
   */
  const applyConsent = (analytics: boolean) => {
    persistBrowserTelemetryConsent(analytics);
    const stored = readBrowserTelemetryConsent(getBrowserTelemetryConsentStorage());
    setConsent(stored);

    if (stored?.analytics !== analytics) {
      setHasSaveFailed(true);
      return false;
    }

    setHasSaveFailed(false);
    return true;
  };

  const handleNecessaryOnly = () => {
    // 許可済みからの撤回は再読み込みを伴うので、先に確認する。
    if (consent?.analytics === true) {
      setIsConfirmingRevoke(true);
      return;
    }
    if (applyConsent(false)) closePanel();
  };

  const handleAllowAnalytics = () => {
    if (applyConsent(true)) closePanel();
  };

  const handleConfirmRevoke = () => {
    if (applyConsent(false)) closePanel();
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
        onClick={() => (isOpen ? closePanel() : setIsOpen(true))}
        className="text-muted-foreground hover:text-foreground min-h-11 text-left text-sm transition-colors hover:underline"
      >
        {t('settings.trigger')}
      </button>
      {isOpen && isConfirmingRevoke && (
        <aside
          className="border-border-subtle bg-card z-modal shadow-card fixed inset-x-4 bottom-4 mx-auto max-w-5xl rounded-2xl border p-4 sm:p-6"
          role="alertdialog"
          aria-labelledby="cookie-consent-revoke-title"
          aria-describedby="cookie-consent-revoke-description"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <h2
                id="cookie-consent-revoke-title"
                className="text-foreground mb-2 text-base font-medium"
              >
                {t('settings.revokeConfirmTitle')}
              </h2>
              <p id="cookie-consent-revoke-description" className="text-muted-foreground text-sm">
                {t('settings.revokeConfirmDescription')}
              </p>
              {hasSaveFailed && (
                <p role="alert" className="text-destructive mt-2 text-sm">
                  {t('settings.saveFailed')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              <Button
                variant="outline"
                onClick={() => setIsConfirmingRevoke(false)}
                className="w-full sm:w-auto"
              >
                {t('settings.revokeCancelLabel')}
              </Button>
              <Button onClick={handleConfirmRevoke} className="w-full sm:w-auto">
                {t('settings.revokeConfirmLabel')}
              </Button>
            </div>
          </div>
        </aside>
      )}
      {isOpen && !isConfirmingRevoke && (
        <CookieConsentBannerView
          idPrefix="cookie-consent-settings"
          title={t('settings.title')}
          description={`${status} ${t('settings.independentOrigins')}`}
          learnMoreLabel={t('banner.learnMore')}
          necessaryOnlyLabel={t('banner.necessaryOnly')}
          allowAnalyticsLabel={t('banner.allowAnalytics')}
          onNecessaryOnly={handleNecessaryOnly}
          onAllowAnalytics={handleAllowAnalytics}
          notice={hasSaveFailed ? t('settings.saveFailed') : undefined}
        />
      )}
    </>
  );
}
