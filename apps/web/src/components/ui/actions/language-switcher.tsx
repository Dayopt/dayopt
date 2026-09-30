import type { Locale } from '@dayopt/i18n/routing';
import { useLocale, useTranslations } from 'next-intl';
import { LanguageSelect, type LanguageSwitcherProps } from './language-select';

export function LanguageSwitcher(props: LanguageSwitcherProps) {
  const t = useTranslations('common');
  return (
    <LanguageSelect {...props} locale={useLocale() as Locale} label={t('aria.changeLanguage')} />
  );
}
