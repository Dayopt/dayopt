'use client';

import { Button } from '@dayopt/components';
import Link from 'next/link';

export interface CookieConsentBannerViewProps {
  /**
   * DOM id の接頭辞。常設の Cookie 設定パネル（CookieConsentSettings）と初回バナーが
   * 同時に描画されうるため、id が衝突しないよう呼び出し側で分ける。
   */
  idPrefix?: string;
  title: string;
  description: string;
  learnMoreLabel: string;
  learnMoreHref?: string;
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
  learnMoreHref = '/legal/cookies',
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
              href={learnMoreHref}
              prefetch={false}
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
