'use client';

import { Link, useRouter } from '@dayopt/i18n/navigation';
import { useState } from 'react';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  ScrollArea,
  Skeleton,
} from '@dayopt/components';
import { createDayoptUrl, dayoptUrls } from '@dayopt/config';
import {
  ArrowLeft,
  Book,
  ChevronDown,
  ChevronRight,
  Crown,
  ExternalLink,
  FileText,
  LogOut,
  Megaphone,
  MessageSquare,
  Scale,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { AppHeader } from '@/components/shell/AppHeader';
import { useAuthStore } from '@/features/auth';
import { APP_NAME, APP_RELEASES_URL, APP_VERSION } from '@/lib/app-info';
import { useLogout } from '@/lib/hooks/useLogout';
import type { MessageKey } from '@/lib/i18n';
import { useShellStore } from '@/lib/stores/useShellStore';
import { api } from '@/lib/trpc';
import { getAvatarUrl, getDisplayName, getInitials } from '@/lib/user';

import { SETTINGS_CATEGORIES } from '../constants';

interface MobileAccountOverviewProps {
  returnPath: string;
  settingsReturnQuery: string;
}

/**
 * Mobile: Instagram風アカウント概要ページ
 *
 * settings/page.tsx から mobile 判定後に呼ばれる。
 */
export function MobileAccountOverview({
  returnPath,
  settingsReturnQuery,
}: MobileAccountOverviewProps) {
  const t = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const user = useAuthStore((s) => s.user);
  const { logout, isLoggingOut } = useLogout();
  const openContact = useShellStore((s) => s.openSheet);
  const [legalOpen, setLegalOpen] = useState(false);

  const displayName = getDisplayName(user, t('navigation.navUser.account'));
  const avatarUrl = getAvatarUrl(user);
  const initials = getInitials(displayName);

  const billingOverview = api.billing.getOverview.useQuery(undefined, { retry: false });
  const access = useBillingAccess();
  const canAccessPro = access.state === 'subscribed';
  const isLoadingBilling = billingOverview.isLoading;

  const helpLinks: Array<{
    labelKey: MessageKey;
    href: string;
    icon: typeof FileText;
    external?: boolean;
    onPress?: () => void;
  }> = [
    {
      labelKey: 'settings.accountPage.releaseNotes',
      href: APP_RELEASES_URL,
      icon: Megaphone,
      external: true,
    },
    {
      labelKey: 'settings.accountPage.documentation',
      href: dayoptUrls.docs,
      icon: Book,
      external: true,
    },
    {
      labelKey: 'settings.accountPage.contact',
      href: '#',
      icon: MessageSquare,
      onPress: () => openContact({ type: 'contact' }),
    },
  ];

  const legalLinks: Array<{
    labelKey: MessageKey;
    href: string;
  }> = [
    {
      labelKey: 'settings.accountPage.termsOfService',
      href: createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/terms`),
    },
    {
      labelKey: 'settings.accountPage.privacyPolicy',
      href: createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/privacy`),
    },
    {
      labelKey: 'settings.accountPage.tokushoho',
      href: createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/tokushoho`),
    },
    {
      labelKey: 'settings.accountPage.security',
      href: createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/security`),
    },
  ];

  return (
    <>
      <div className="bg-background sticky top-0 z-20">
        <AppHeader
          leftSlot={
            <Button variant="ghost" size="sm" icon asChild className="-ml-2">
              <Link href={returnPath} aria-label={t('common.back')}>
                <ArrowLeft className="size-5" />
              </Link>
            </Button>
          }
        >
          <h1 className="text-lg font-medium">{t('navigation.navUser.account')}</h1>
        </AppHeader>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* B. ヒーローエリア */}
        <div className="px-4 pt-4 pb-6">
          <Card className="border-border-subtle gap-0 overflow-hidden rounded-lg py-0 shadow-sm">
            {/* Row 1: Avatar + Name/Email + Plan Badge */}
            <Link
              href={`/settings/account${settingsReturnQuery}`}
              className="hover:bg-state-hover active:bg-state-hover flex items-center gap-4 px-4 py-4 transition-colors duration-150"
            >
              <Avatar size="lg">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
                <AvatarFallback className="bg-foreground text-background text-base">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{displayName}</p>
                {user?.email && (
                  <p className="text-muted-foreground truncate text-xs">{user.email}</p>
                )}
              </div>
              {isLoadingBilling ? (
                <Skeleton className="h-6 w-10 rounded-lg" />
              ) : (
                <Badge variant={canAccessPro ? 'primary' : 'outline'}>
                  {t('settings.subscription.singlePlan.name')}
                </Badge>
              )}
            </Link>

            {/* Row 2: Upgrade CTA(Free時のみ) */}
            {!isLoadingBilling && !canAccessPro && (
              <button
                type="button"
                onClick={() => router.push(`/settings/billing${settingsReturnQuery}`)}
                className="border-border-subtle hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 border-t px-4 py-4 transition-colors duration-150"
              >
                <Crown className="text-primary size-5 shrink-0" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-base font-medium">
                    {t('settings.subscription.singlePlan.purchase')}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('settings.subscription.singlePlan.included')}
                  </p>
                </div>
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              </button>
            )}
          </Card>
        </div>

        {/* 設定カテゴリ */}
        <nav className="flex flex-col p-2">
          {SETTINGS_CATEGORIES.map((category) => {
            const Icon = category.icon;
            return (
              <Link
                key={category.id}
                href={`/settings/${category.id}${settingsReturnQuery}`}
                className="text-foreground hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg px-4 py-4 text-left text-base transition-colors"
              >
                {/* C. カテゴリアイコン色 */}
                <Icon className="text-muted-foreground size-5 shrink-0" />
                <span className="flex-1 font-normal">{t(category.labelKey)}</span>
                <ChevronRight className="text-muted-foreground size-4" />
              </Link>
            );
          })}
        </nav>

        {/* ヘルプ & サポート */}
        <div className="border-border border-t px-2 pt-1">
          <nav className="flex flex-col">
            {helpLinks.map((link) => {
              const Icon = link.icon;
              if (link.onPress) {
                return (
                  <button
                    key={link.labelKey}
                    type="button"
                    onClick={link.onPress}
                    className="text-foreground hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg px-4 py-4 text-left text-base transition-colors"
                  >
                    {/* C. アイコン色 */}
                    <Icon className="text-muted-foreground size-5 shrink-0" />
                    <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                  </button>
                );
              }
              return (
                <a
                  key={link.labelKey}
                  href={link.href}
                  target={link.external ? '_blank' : undefined}
                  rel={link.external ? 'noopener noreferrer' : undefined}
                  className="text-foreground hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg px-4 py-4 text-left text-base transition-colors"
                >
                  {/* C. アイコン色 */}
                  <Icon className="text-muted-foreground size-5 shrink-0" />
                  <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                  {link.external && <ExternalLink className="text-muted-foreground size-3.5" />}
                </a>
              );
            })}

            {/* E. 法的情報の折りたたみ */}
            <button
              type="button"
              onClick={() => setLegalOpen((prev) => !prev)}
              className="text-foreground hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg px-4 py-4 text-left text-base transition-colors"
            >
              <Scale className="text-muted-foreground size-5 shrink-0" />
              <span className="flex-1 font-normal">{t('settings.accountPage.legal')}</span>
              <ChevronDown
                className={`text-muted-foreground size-4 transition-transform ${legalOpen ? 'rotate-180' : ''}`}
              />
            </button>
            <div
              // eslint-disable-next-line tailwindcss/no-arbitrary-value -- grid expand/collapse animation
              className={`grid transition-[grid-template-rows] duration-200 ${legalOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            >
              <div className="overflow-hidden">
                {legalLinks.map((link) => (
                  <a
                    key={link.labelKey}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg py-4 pr-4 pl-12 text-left text-base transition-colors"
                  >
                    <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                    <ExternalLink className="text-muted-foreground size-3.5" />
                  </a>
                ))}
              </div>
            </div>
          </nav>
        </div>

        {/* ログアウト */}
        <div className="border-border border-t px-2 pt-1 pb-24">
          <button
            type="button"
            onClick={logout}
            disabled={isLoggingOut}
            className="text-destructive hover:bg-state-hover active:bg-state-hover flex w-full items-center gap-4 rounded-lg px-4 py-4 text-left text-base transition-colors"
          >
            <LogOut className="text-destructive size-5 shrink-0" />
            <span className="flex-1 font-normal">
              {isLoggingOut ? t('navigation.navUser.loggingOut') : t('navigation.navUser.logout')}
            </span>
          </button>

          {/* バージョン表示 */}
          <p className="text-muted-foreground mt-2 px-4 text-xs">
            {APP_NAME} v{APP_VERSION}
          </p>
        </div>
      </ScrollArea>
    </>
  );
}
