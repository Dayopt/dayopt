import type { Locale } from '@dayopt/i18n/routing';
import { sitePath } from '@web/platform/i18n/site-path';
import { useLocale, useTranslations } from 'next-intl';
import { CookieConsentSettingsClient } from './CookieConsentSettingsClient';
import { cookieSettingsCopyKeys, type CookieSettingsCopy } from './cookie-consent-copy';

export function CookieConsentSettings() {
  const t = useTranslations('common.cookies');
  const locale = useLocale() as Locale;
  const copy = Object.fromEntries(
    cookieSettingsCopyKeys.map((key) => [key, t(key)]),
  ) as CookieSettingsCopy;
  return (
    <CookieConsentSettingsClient
      copy={{ ...copy, learnMoreHref: sitePath('/legal/cookies', locale) }}
    />
  );
}
