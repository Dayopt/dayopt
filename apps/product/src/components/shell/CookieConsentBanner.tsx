'use client';

import { useEffect, useState } from 'react';

import { acceptAllCookies, acceptNecessaryOnly, needsCookieConsent } from '@/lib/cookie-consent';
import { createDayoptUrl, dayoptUrls } from '@dayopt/config';
import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  isBrowserTelemetryConsentStorageChange,
} from '@dayopt/observability';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { Button } from '@dayopt/components';

/**
 * Cookie同意バナー
 *
 * GDPR・ePrivacy指令準拠のCookie同意取得バナー
 *
 * 機能：
 * - 初回訪問時のみ表示（同意済みの場合は非表示）
 * - authページでは非表示（LCP改善: 認証後に表示）
 * - 選択肢：すべて同意、必須のみ、プライバシーポリシーへのリンク
 * - 固定位置（画面下部）
 * - レスポンシブ対応
 * - LCP改善のため遅延表示（requestIdleCallback後）
 */
export function CookieConsentBanner() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  // LCP改善: 初期値falseで遅延表示
  const [showBanner, setShowBanner] = useState(false);

  // LCP改善: authページでは非表示（認証後のページで表示）
  const isAuthPage = pathname?.includes('/auth');

  // LCP改善: requestIdleCallbackで遅延チェック
  useEffect(() => {
    // authページではスキップ
    if (isAuthPage) return;

    const checkConsent = () => {
      if (needsCookieConsent()) {
        setShowBanner(true);
      }
    };

    // 設定（データ設定の分析同意セクション）や別タブで選択が確定したら、
    // 同じ質問を繰り返さないようバナーを閉じる。逆に未選択へ戻れば再び出す。
    const syncWithStoredConsent = () => setShowBanner(needsCookieConsent());
    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
      syncWithStoredConsent();
    };

    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, syncWithStoredConsent);
    window.addEventListener('storage', handleStorage);

    let cancelInitialCheck: () => void;
    if ('requestIdleCallback' in window) {
      const handle = requestIdleCallback(checkConsent, { timeout: 2000 });
      cancelInitialCheck = () => cancelIdleCallback(handle);
    } else {
      // フォールバック: 1秒後にチェック
      const timer = setTimeout(checkConsent, 1000);
      cancelInitialCheck = () => clearTimeout(timer);
    }

    return () => {
      cancelInitialCheck();
      window.removeEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, syncWithStoredConsent);
      window.removeEventListener('storage', handleStorage);
    };
  }, [isAuthPage]);

  const handleAcceptAll = () => {
    acceptAllCookies();
    setShowBanner(false);
  };

  const handleAcceptNecessaryOnly = () => {
    acceptNecessaryOnly();
    setShowBanner(false);
  };

  // SSR時、または同意済みの場合は何も表示しない
  if (!showBanner) {
    return null;
  }

  const privacyUrl = createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/privacy`);

  return (
    <div
      className="border-border-subtle bg-card shadow-card fixed inset-x-0 bottom-0 z-50 border-t p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-labelledby="cookie-consent-title"
      aria-describedby="cookie-consent-description"
    >
      <div className="container mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* メッセージ */}
          <div className="flex-1">
            <h2 id="cookie-consent-title" className="text-foreground mb-1 text-base font-medium">
              {t('common.cookies.banner.title')}
            </h2>
            <p id="cookie-consent-description" className="text-muted-foreground text-sm">
              {t('common.cookies.banner.description')}{' '}
              <a
                href={privacyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground hover:text-foreground underline"
              >
                {t('common.cookies.banner.learnMore')}
              </a>
            </p>
          </div>

          {/* アクションボタン（右が最重要 = GAFA慣習） */}
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <Button
              onClick={handleAcceptNecessaryOnly}
              variant="outline"
              className="w-full sm:w-auto"
            >
              {t('common.cookies.banner.rejectAll')}
            </Button>
            <Button onClick={handleAcceptAll} className="w-full sm:w-auto">
              {t('common.cookies.banner.acceptAll')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
