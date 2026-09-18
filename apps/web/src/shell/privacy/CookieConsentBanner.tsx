'use client';

import { Button } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  isBrowserTelemetryConsentStorageChange,
} from '@dayopt/observability';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  needsBrowserTelemetryConsent,
  persistBrowserTelemetryConsent,
} from '@web/platform/privacy/browser-telemetry-consent';

interface CookieConsentBannerViewProps {
  /**
   * DOM id の接頭辞。常設の Cookie 設定パネル（CookieConsentSettings）と初回バナーが
   * 同時に描画されうるため、id が衝突しないよう呼び出し側で分ける。
   */
  idPrefix?: string;
  title: string;
  description: string;
  learnMoreLabel: string;
  necessaryOnlyLabel: string;
  allowAnalyticsLabel: string;
  onNecessaryOnly: () => void;
  onAllowAnalytics: () => void;
  /** 選択の保存に失敗したときなど、操作の結果を伝える 1 行。初回バナーでは渡さない。 */
  notice?: string;
}

export function CookieConsentBannerView({
  idPrefix = 'cookie-consent',
  title,
  description,
  learnMoreLabel,
  necessaryOnlyLabel,
  allowAnalyticsLabel,
  onNecessaryOnly,
  onAllowAnalytics,
  notice,
}: CookieConsentBannerViewProps) {
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  return (
    <aside
      className="border-border-subtle bg-card z-modal shadow-card fixed inset-x-4 bottom-4 mx-auto max-w-5xl rounded-2xl border p-4 sm:p-6"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1">
          <h2 id={titleId} className="text-foreground mb-2 text-base font-medium">
            {title}
          </h2>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {description}{' '}
            <Link
              href="/legal/cookies"
              className="text-foreground underline transition-colors duration-150 hover:no-underline"
            >
              {learnMoreLabel}
            </Link>
          </p>
          {notice && (
            <p role="alert" className="text-destructive mt-2 text-sm">
              {notice}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <Button variant="outline" onClick={onNecessaryOnly} className="w-full sm:w-auto">
            {necessaryOnlyLabel}
          </Button>
          <Button onClick={onAllowAnalytics} className="w-full sm:w-auto">
            {allowAnalyticsLabel}
          </Button>
        </div>
      </div>
    </aside>
  );
}

/** Ask once before enabling browser error monitoring or analytics. */
export function CookieConsentBanner() {
  const t = useTranslations('common.cookies.banner');
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
      title={t('title')}
      description={t('description')}
      learnMoreLabel={t('learnMore')}
      necessaryOnlyLabel={t('necessaryOnly')}
      allowAnalyticsLabel={t('allowAnalytics')}
      onNecessaryOnly={() => chooseConsent(false)}
      onAllowAnalytics={() => chooseConsent(true)}
    />
  );
}
