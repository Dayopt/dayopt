'use client';

import { usePathname } from 'next/navigation';

import { Link } from '@dayopt/i18n/navigation';

import { useTranslations } from 'next-intl';

import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useShellStore } from '@/lib/stores/useShellStore';
import { cn, ScrollArea } from '@dayopt/components';

import { SETTINGS_CATEGORIES } from '../constants';

import type { SettingsCategory } from '../types';

interface SettingsSidebarProps {
  className?: string;
  presentation?: 'page' | 'dialog';
}

/**
 * 設定サイドバー
 *
 * PC（Dialog内）: store でカテゴリ切替（URL変更なし）
 * Mobile（実ページ）: Link でページ遷移
 */
export function SettingsSidebar({ className, presentation = 'page' }: SettingsSidebarProps) {
  const t = useTranslations();
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const pathname = usePathname() ?? '/';

  // PC: store から、Mobile: pathname から現在カテゴリを取得
  const activeSheet = useShellStore((s) => s.activeSheet);
  const storeCategory = activeSheet?.type === 'settings' ? activeSheet.category : 'account';
  const setCategory = useShellStore((s) => s.setSettingsCategory);
  const pathCategory = pathname.split('/settings/')[1]?.split('/')[0] ?? 'account';
  const usePageNavigation = isMobile && presentation === 'page';
  const currentCategory = usePageNavigation ? pathCategory : storeCategory;

  return (
    <aside className={cn('bg-surface-container flex flex-col', className)}>
      <div className="flex h-12 items-center px-6 pt-4">
        <h2 className="text-lg font-medium">{t('settings.dialog.title')}</h2>
      </div>
      <ScrollArea className="flex-1">
        <nav
          className={cn(
            'flex gap-1 p-2',
            presentation === 'dialog' ? 'flex-row overflow-x-auto md:flex-col' : 'flex-col',
          )}
        >
          {SETTINGS_CATEGORIES.map((category) => {
            const Icon = category.icon;
            const isActive = currentCategory === category.id;

            if (usePageNavigation) {
              return (
                <Link
                  key={category.id}
                  href={`/settings/${category.id}`}
                  className={cn(
                    'flex w-full items-center gap-4 rounded-lg px-4 py-2 text-left text-base transition-colors',
                    isActive
                      ? 'bg-state-selected text-foreground'
                      : 'text-muted-foreground hover:bg-state-hover',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="font-normal">{t(category.labelKey)}</span>
                </Link>
              );
            }

            return (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategory(category.id as SettingsCategory)}
                className={cn(
                  'flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-left text-sm whitespace-nowrap transition-colors md:min-h-0 md:w-full md:gap-4',
                  isActive
                    ? 'bg-state-selected text-foreground'
                    : 'text-muted-foreground hover:bg-state-hover',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="font-normal">{t(category.labelKey)}</span>
              </button>
            );
          })}
        </nav>
      </ScrollArea>
    </aside>
  );
}
