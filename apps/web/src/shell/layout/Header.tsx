'use client';

import { Button, cn, Logo, Sheet, SheetContent } from '@dayopt/components';
import { Link, usePathname } from '@dayopt/i18n/navigation';
import { Menu } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { trackSignupCta } from '@web/platform/analytics/signup-cta';
import { productSignupUrl } from '@web/platform/config/product-signup-url';

import styles from './SiteChrome.module.css';

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const t = useTranslations('common');
  const locale = useLocale();

  const pathname = usePathname();

  const navigation = [
    { name: t('navigation.home'), href: '/' },
    { name: t('navigation.blog'), href: '/blog' },
    { name: t('navigation.docs'), href: '/docs' },
  ];

  // ハッシュリンク（/#features 等）は対象外。/blog・/docs などの実ページのみハイライト
  const isActive = (href: string) =>
    !href.includes('#') && (pathname === href || pathname.startsWith(`${href}/`));

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          setIsScrolled(window.scrollY > 10);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header className={cn(styles.header, isScrolled && styles.scrolled)} lang={locale}>
      <nav
        className={cn(styles.nav, 'flex h-16 items-center justify-between lg:h-20')}
        aria-label={t('aria.mainNavigation')}
      >
        {/* Logo */}
        <div className="flex lg:flex-1">
          <Link href="/" className="flex items-center gap-2">
            <Logo variant="lockup" size="sm" className="lg:hidden" />
            <Logo variant="lockup" size="md" className="hidden lg:inline-flex" />
          </Link>
        </div>

        {/* Desktop navigation */}
        <div className="hidden lg:flex lg:items-center lg:gap-x-1">
          {navigation.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'rounded-lg px-2 py-1 text-base font-medium transition-colors',
                isActive(item.href)
                  ? 'bg-state-selected text-foreground'
                  : 'text-muted-foreground hover:bg-state-hover hover:text-foreground',
              )}
            >
              {item.name}
            </Link>
          ))}
        </div>

        {/* Right side actions */}
        <div className="flex flex-1 items-center justify-end gap-x-2">
          {/* Desktop: Login + Signup */}
          <div className="hidden lg:flex lg:items-center lg:gap-x-2">
            <Button variant="ghost" size="default" asChild>
              <Link href="/login">{t('actions.login')}</Link>
            </Button>
            <Button variant="primary" size="default" className={styles.signup} asChild>
              <a href={productSignupUrl()} onClick={() => trackSignupCta('header_desktop')}>
                {t('actions.signup')}
              </a>
            </Button>
          </div>

          {/* Mobile: Login + Signup + Menu */}
          <div className="flex items-center gap-x-2 lg:hidden">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">{t('actions.login')}</Link>
            </Button>
            <Button variant="primary" size="sm" className={styles.signup} asChild>
              <a href={productSignupUrl()} onClick={() => trackSignupCta('header_mobile')}>
                {t('actions.signup')}
              </a>
            </Button>
            <Button
              variant="ghost"
              icon
              size="sm"
              onClick={() => setMobileMenuOpen(true)}
              aria-label={t('aria.openMenu')}
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Mobile menu */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="right"
          aria-label={t('aria.navigationMenu')}
          closeButtonLabel={t('aria.closeMenu')}
          className="w-4/5 max-w-80 overflow-y-auto px-6 py-6 lg:hidden"
        >
          <Link
            href="/"
            className="flex items-center gap-2"
            onClick={() => setMobileMenuOpen(false)}
          >
            <Logo variant="lockup" size="md" />
          </Link>

          <div className="mt-6 flow-root">
            <div className="divide-border -my-6 divide-y">
              <div className="space-y-1 py-6">
                {navigation.map((item) => (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                    className={cn(
                      'block rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                      isActive(item.href)
                        ? 'bg-state-selected text-foreground'
                        : 'text-foreground hover:bg-state-hover',
                    )}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>

              <div className="py-6">
                <Button variant="outline" className="w-full" asChild>
                  <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                    {t('actions.login')}
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}
