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
import { APP_NAME, APP_VERSION, getReleaseNotesUrl } from '@/lib/app-info';
import { useLogout } from '@/lib/hooks/useLogout';
import type { MessageKey } from '@/lib/i18n';
import { useShellStore } from '@/lib/stores/useShellStore';
import { api } from '@/lib/trpc';
import { getAvatarUrl, getDisplayName, getInitials } from '@/lib/user';

import { SETTINGS_CATEGORIES } from '../constants';
import type { SettingsCategory } from '../types';

interface MobileAccountOverviewProps {
  returnPath: string;
  settingsReturnQuery: string;
}

const CATEGORY_GROUPS: readonly {
  id: string;
  labelKey: MessageKey;
  categories: readonly SettingsCategory[];
}[] = [
  {
    id: 'settings',
    labelKey: 'settings.accountPage.sections.settings',
    categories: ['account', 'display'],
  },
  {
    id: 'data',
    labelKey: 'settings.accountPage.sections.data',
    categories: ['data', 'integrations'],
  },
  {
    id: 'plan',
    labelKey: 'settings.accountPage.sections.plan',
    categories: ['billing'],
  },
];

interface SettingsSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

function SettingsSection({ id, title, children }: SettingsSectionProps) {
  const headingId = `settings-section-${id}`;

  return (
    <section className="space-y-2">
      <h2 id={headingId} className="text-muted-foreground px-1 text-xs font-medium">
        {title}
      </h2>
      <Card className="border-border-subtle gap-0 overflow-hidden rounded-lg py-0 shadow-sm">
        <nav aria-labelledby={headingId}>{children}</nav>
      </Card>
    </section>
  );
}

/**
 * Mobile: プロフィールと設定をグループ表示するアカウント概要ページ
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
      href: getReleaseNotesUrl(locale),
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
        <div className="space-y-6 px-4 pt-4 pb-24">
          <Card className="border-border-subtle gap-0 overflow-hidden rounded-lg py-0 shadow-sm">
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <Avatar size="lg">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
                <AvatarFallback className="bg-foreground text-background text-base">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="max-w-full min-w-0">
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
            </div>

            {!isLoadingBilling && !canAccessPro && (
              <button
                type="button"
                onClick={() => router.push(`/settings/billing${settingsReturnQuery}`)}
                className="border-border-subtle hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 border-t px-4 py-3 text-left transition-colors duration-150"
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

          <div className="space-y-6">
            {CATEGORY_GROUPS.map((group) => {
              const categories = SETTINGS_CATEGORIES.filter((category) =>
                group.categories.includes(category.id),
              );

              return (
                <SettingsSection key={group.id} id={group.id} title={t(group.labelKey)}>
                  <ul className="divide-border divide-y">
                    {categories.map((category) => {
                      const Icon = category.icon;

                      return (
                        <li key={category.id}>
                          <Link
                            href={`/settings/${category.id}${settingsReturnQuery}`}
                            className="text-foreground hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 px-4 py-3 text-left text-base transition-colors duration-150"
                          >
                            <Icon className="text-muted-foreground size-5 shrink-0" />
                            <span className="flex-1 font-normal">{t(category.labelKey)}</span>
                            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </SettingsSection>
              );
            })}

            <SettingsSection id="support" title={t('settings.accountPage.sections.support')}>
              <ul className="divide-border divide-y">
                {helpLinks.map((link) => {
                  const Icon = link.icon;
                  if (link.onPress) {
                    return (
                      <li key={link.labelKey}>
                        <button
                          type="button"
                          onClick={link.onPress}
                          className="text-foreground hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 px-4 py-3 text-left text-base transition-colors duration-150"
                        >
                          <Icon className="text-muted-foreground size-5 shrink-0" />
                          <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={link.labelKey}>
                      <a
                        href={link.href}
                        target={link.external ? '_blank' : undefined}
                        rel={link.external ? 'noopener noreferrer' : undefined}
                        className="text-foreground hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 px-4 py-3 text-left text-base transition-colors duration-150"
                      >
                        <Icon className="text-muted-foreground size-5 shrink-0" />
                        <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                        {link.external && (
                          <ExternalLink className="text-muted-foreground size-3.5 shrink-0" />
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </SettingsSection>

            <SettingsSection id="other" title={t('settings.accountPage.sections.other')}>
              <ul>
                <li>
                  <button
                    type="button"
                    aria-expanded={legalOpen}
                    aria-controls="settings-legal-links"
                    onClick={() => setLegalOpen((prev) => !prev)}
                    className="text-foreground hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 px-4 py-3 text-left text-base transition-colors duration-150"
                  >
                    <Scale className="text-muted-foreground size-5 shrink-0" />
                    <span className="flex-1 font-normal">{t('settings.accountPage.legal')}</span>
                    <ChevronDown
                      className={`text-muted-foreground size-4 shrink-0 transition-transform ${legalOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <div
                    id="settings-legal-links"
                    aria-hidden={!legalOpen}
                    inert={!legalOpen}
                    // eslint-disable-next-line tailwindcss/no-arbitrary-value -- grid expand/collapse animation
                    className={`grid transition-[grid-template-rows] duration-200 ${legalOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                  >
                    <div className="overflow-hidden">
                      <ul className="divide-border divide-y">
                        {legalLinks.map((link) => (
                          <li key={link.labelKey}>
                            <a
                              href={link.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-foreground hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 py-3 pr-4 pl-12 text-left text-base transition-colors duration-150"
                            >
                              <span className="flex-1 font-normal">{t(link.labelKey)}</span>
                              <ExternalLink className="text-muted-foreground size-3.5 shrink-0" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </li>
              </ul>
            </SettingsSection>
          </div>

          <div className="space-y-2">
            <Card className="border-border-subtle gap-0 overflow-hidden rounded-lg py-0 shadow-sm">
              <button
                type="button"
                onClick={logout}
                disabled={isLoggingOut}
                className="text-destructive hover:bg-state-hover active:bg-state-hover flex min-h-12 w-full items-center gap-4 px-4 py-3 text-left text-base transition-colors duration-150"
              >
                <LogOut className="text-destructive size-5 shrink-0" />
                <span className="flex-1 font-normal">
                  {isLoggingOut
                    ? t('navigation.navUser.loggingOut')
                    : t('navigation.navUser.logout')}
                </span>
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              </button>
            </Card>

            <p className="text-muted-foreground px-4 text-xs">
              {APP_NAME} v{APP_VERSION}
            </p>
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
