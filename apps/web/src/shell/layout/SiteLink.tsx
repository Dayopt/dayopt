import type { Locale } from '@dayopt/i18n/routing';
import { sitePath } from '@web/platform/i18n/site-path';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import type { ComponentProps } from 'react';

/** Resolve public URLs on the server; navigation keeps Next's normal link behavior. */
export function SiteLink({ href, ...props }: ComponentProps<typeof Link> & { href: string }) {
  const locale = useLocale() as Locale;
  return <Link {...props} href={sitePath(href, locale)} />;
}
