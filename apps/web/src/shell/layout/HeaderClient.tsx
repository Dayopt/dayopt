'use client';

import { Button, cn } from '@dayopt/components';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import { trackSignupCta } from '@web/platform/analytics/signup-cta';
import { productLoginUrl, productSignupUrl } from '@web/platform/config/product-signup-url';

import styles from './SiteChrome.module.css';

const HeaderMobileMenu = lazy(() =>
  import('./HeaderMobileMenu').then((module) => ({ default: module.HeaderMobileMenu })),
);

export interface HeaderLabels {
  mainNavigation: string;
  login: string;
  signup: string;
  openMenu: string;
  navigationMenu: string;
  closeMenu: string;
  loading: string;
}

export function HeaderClient({
  locale,
  logo,
  homeUrl,
  navigation,
  labels,
}: {
  locale: string;
  logo: ReactNode;
  homeUrl: string;
  navigation: Array<{ name: string; href: string; url: string }>;
  labels: HeaderLabels;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuRequested, setMobileMenuRequested] = useState(false);
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const pathname = (usePathname() ?? '/').replace(/^\/(ja|en)(?=\/|$)/, '') || '/';

  // ハッシュリンク（/#features 等）は対象外。/blog・/docs などの実ページのみハイライト
  const isActive = (href: string) =>
    !href.includes('#') && (pathname === href || pathname.startsWith(`${href}/`));

  useEffect(() => {
    if (!mobileMenuOpen) return;
    // 読み込み待ちの間も開く操作を取り消せる。
    const cancelMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', cancelMenu);
    return () => window.removeEventListener('keydown', cancelMenu);
  }, [mobileMenuOpen]);

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
        aria-label={labels.mainNavigation}
      >
        {/* Logo */}
        <div className="flex lg:flex-1">
          <Link href={homeUrl} prefetch={false} className="flex items-center gap-2">
            {logo}
          </Link>
        </div>

        {/* Desktop navigation */}
        <div className="hidden lg:flex lg:items-center lg:gap-x-1">
          {navigation.map((item) => (
            <Link
              key={item.name}
              href={item.url}
              prefetch={false}
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
              <a href={productLoginUrl()}>{labels.login}</a>
            </Button>
            <Button variant="primary" size="default" className={styles.signup} asChild>
              <a href={productSignupUrl()} onClick={() => trackSignupCta('header_desktop')}>
                {labels.signup}
              </a>
            </Button>
          </div>

          {/* Mobile: Login + Signup + Menu */}
          <div className="flex items-center gap-x-2 lg:hidden">
            <Button variant="ghost" size="sm" className={styles.mobileLogin} asChild>
              <a href={productLoginUrl()}>{labels.login}</a>
            </Button>
            <Button variant="primary" size="sm" className={styles.signup} asChild>
              <a href={productSignupUrl()} onClick={() => trackSignupCta('header_mobile')}>
                {labels.signup}
              </a>
            </Button>
            <Button
              ref={mobileMenuButton}
              variant="ghost"
              icon
              size="sm"
              onClick={() => {
                setMobileMenuRequested(true);
                setMobileMenuOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={mobileMenuOpen}
              aria-label={labels.openMenu}
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </nav>

      {mobileMenuRequested && (
        <Suspense
          fallback={
            mobileMenuOpen ? (
              <span className="sr-only" role="status">
                {labels.loading}
              </span>
            ) : null
          }
        >
          <HeaderMobileMenu
            homeUrl={homeUrl}
            navigation={navigation}
            labels={labels}
            open={mobileMenuOpen}
            isActive={isActive}
            onOpenChange={setMobileMenuOpen}
            onCloseAutoFocus={() => mobileMenuButton.current?.focus()}
          />
        </Suspense>
      )}
    </header>
  );
}
