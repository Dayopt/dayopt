import type { OgCategory } from '@dayopt/assets/og';
import type { Locale } from '@dayopt/i18n/routing';
import enMessages from '../../../messages/en/common.json';
import jaMessages from '../../../messages/ja/common.json';

const CATEGORY_LABELS: Record<Locale, Record<OgCategory, string>> = {
  en: enMessages.common.metadata.ogCategories,
  ja: jaMessages.common.metadata.ogCategories,
};

/** Accept only supported page locales; old OGP URLs keep the English label. */
export function normalizeOgLocale(locale: string | null | undefined): Locale {
  return locale === 'ja' ? 'ja' : 'en';
}

export function getOgCategoryLabel(locale: Locale, category: OgCategory): string {
  return CATEGORY_LABELS[locale][category];
}
