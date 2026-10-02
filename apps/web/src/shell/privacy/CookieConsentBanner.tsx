import type { Locale } from '@dayopt/i18n/routing';
import { sitePath } from '@web/platform/i18n/site-path';
import { useLocale, useTranslations } from 'next-intl';
import { CookieConsentBannerClient } from './CookieConsentBannerClient';

export { CookieConsentBannerView } from './CookieConsentBannerView';

/** Localized consent copy is server-rendered; consent storage and events remain client-side. */
export function CookieConsentBanner() {
  const t = useTranslations('common.cookies.banner');
  const locale = useLocale() as Locale;
  return (
    <CookieConsentBannerClient
      copy={{
        title: t('title'),
        description: t('description'),
        learnMoreLabel: t('learnMore'),
        learnMoreHref: sitePath('/legal/cookies', locale),
        necessaryOnlyLabel: t('necessaryOnly'),
        allowAnalyticsLabel: t('allowAnalytics'),
      }}
    />
  );
}
