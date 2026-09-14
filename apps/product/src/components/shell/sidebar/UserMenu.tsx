'use client';

import {
  Book,
  Building,
  Crown,
  ExternalLink,
  FileText,
  Keyboard,
  LogOut,
  Megaphone,
  MessageSquare,
  Settings,
  Shield,
  UserCircle,
} from 'lucide-react';
import Link from 'next/link';

import { createDayoptUrl, dayoptUrls } from '@dayopt/config';

import { getReleaseNotesUrl } from '@/lib/app-info';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useLogout } from '@/lib/hooks/useLogout';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useShellStore } from '@/lib/stores/useShellStore';
import { getInitials } from '@/lib/user';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dayopt/components';
import { useRouter } from '@dayopt/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';

import type { SettingsCategory } from '@/lib/types/settings';

/** アカウントメニューとSidebarのヘルプメニューで共有する項目。 */
export function HelpMenuItems() {
  const t = useTranslations();
  const locale = useLocale();
  const openSheet = useShellStore((s) => s.openSheet);

  return (
    <>
      <DropdownMenuItem onSelect={() => openSheet({ type: 'shortcutCheatSheet' })}>
        <Keyboard />
        {t('navigation.navUser.helpSubmenu.keyboardShortcuts')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href={getReleaseNotesUrl(locale)} target="_blank" rel="noopener noreferrer">
          <Megaphone />
          {t('navigation.navUser.helpSubmenu.releaseNotes')}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href={dayoptUrls.docs} target="_blank" rel="noopener noreferrer">
          <Book />
          <span className="flex-1">{t('navigation.navUser.helpSubmenu.documentation')}</span>
          <ExternalLink className="text-muted-foreground size-3.5" />
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <a
          href={createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/terms`)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText />
          <span className="flex-1">{t('navigation.navUser.helpSubmenu.termsOfService')}</span>
          <ExternalLink className="text-muted-foreground size-3.5" />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a
          href={createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/privacy`)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText />
          <span className="flex-1">{t('navigation.navUser.helpSubmenu.privacyPolicy')}</span>
          <ExternalLink className="text-muted-foreground size-3.5" />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a
          href={createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/tokushoho`)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Building />
          <span className="flex-1">{t('navigation.navUser.helpSubmenu.tokushoho')}</span>
          <ExternalLink className="text-muted-foreground size-3.5" />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a
          href={createDayoptUrl(dayoptUrls.marketing, `/${locale}/legal/security`)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Shield />
          <span className="flex-1">{t('navigation.navUser.helpSubmenu.security')}</span>
          <ExternalLink className="text-muted-foreground size-3.5" />
        </a>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openSheet({ type: 'contact' })}>
        <MessageSquare />
        {t('navigation.navUser.helpSubmenu.contact')}
      </DropdownMenuItem>
    </>
  );
}

/** ユーザー名から開くアカウントメニュー。設定・ログアウトへのアクセスを提供する。 */
export function UserMenu({
  user,
}: {
  user: {
    name: string;
    email: string;
    avatar?: string | null;
  };
}) {
  const router = useRouter();
  const { logout, isLoggingOut } = useLogout();
  const t = useTranslations();
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const openSettings = useShellStore((s) => s.openSettings);

  const handleOpenSettings = (category: SettingsCategory) => {
    if (isMobile) {
      router.push(`/settings/${category}`);
    } else {
      openSettings(category);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="hover:bg-state-hover data-[state=open]:bg-state-selected flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm outline-hidden"
          aria-label={t('navigation.navUser.accountMenuLabel', { name: user.name })}
        >
          <Avatar size="xs" className="shrink-0 rounded-2xl">
            {user.avatar ? <AvatarImage src={user.avatar} alt={user.name} /> : null}
            <AvatarFallback className="bg-foreground text-background rounded-2xl text-xs">
              {getInitials(user.name)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate font-normal">{user.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // eslint-disable-next-line tailwindcss/no-arbitrary-value -- Radix CSS variable
        className="border-input w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-2xl"
        side="right"
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-2 py-2 text-left text-sm">
            <Avatar size="xs" className="rounded-2xl">
              {user.avatar ? <AvatarImage src={user.avatar} alt={user.name} /> : null}
              <AvatarFallback className="bg-foreground text-background rounded-2xl text-xs">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-normal">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* アカウント関連 */}
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => handleOpenSettings('account')}>
            <UserCircle />
            {t('navigation.navUser.account')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleOpenSettings('billing')}>
            <Crown />
            {t('navigation.navUser.upgradePlan')}
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* 設定 */}
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => handleOpenSettings('account')}>
            <Settings />
            {t('navigation.navUser.settings')}
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* ログアウト */}
        <DropdownMenuItem variant="destructive" onClick={logout} disabled={isLoggingOut}>
          <LogOut />
          {isLoggingOut ? t('navigation.navUser.loggingOut') : t('navigation.navUser.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
