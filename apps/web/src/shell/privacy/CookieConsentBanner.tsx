'use client';

import { Button } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
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

    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const handle = idleWindow.requestIdleCallback(checkConsent, { timeout: 2000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }

    const timer = globalThis.setTimeout(checkConsent, 1000);
    return () => globalThis.clearTimeout(timer);
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
