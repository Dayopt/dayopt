import { DEFAULT_LOCALE, LOCALE_PREFIX, type Locale } from '@dayopt/config';

/** Public site paths use the shared locale-prefix policy and no translated pathnames. */
export function sitePath(href: string, locale: Locale): string {
  if (LOCALE_PREFIX === 'as-needed' && locale === DEFAULT_LOCALE) return href;
  return `/${locale}${href === '/' ? '' : href}`;
}
