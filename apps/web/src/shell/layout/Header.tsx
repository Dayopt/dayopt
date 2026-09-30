import type { Locale } from '@dayopt/i18n/routing';
import { sitePath } from '@web/platform/i18n/site-path';
import { useLocale, useTranslations } from 'next-intl';

import { HeaderClient } from './HeaderClient';

/** Translate once on the server; the client owns only menu, scroll and active-route state. */
export function Header() {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;
  const navigation = [
    { name: t('navigation.home'), href: '/' },
    { name: t('navigation.blog'), href: '/blog' },
    { name: t('navigation.docs'), href: '/docs' },
  ].map((item) => ({ ...item, url: sitePath(item.href, locale) }));
  return (
    <HeaderClient
      locale={locale}
      homeUrl={sitePath('/', locale)}
      navigation={navigation}
      labels={{
        mainNavigation: t('aria.mainNavigation'),
        login: t('actions.login'),
        signup: t('actions.signup'),
        openMenu: t('aria.openMenu'),
        navigationMenu: t('aria.navigationMenu'),
        closeMenu: t('aria.closeMenu'),
        loading: t('states.loading'),
      }}
    />
  );
}
