'use client';

import { useTranslations } from 'next-intl';

import { XIcon } from 'lucide-react';

import { useShellStore } from '@/lib/stores/useShellStore';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from '@dayopt/components';

import { SettingsContent } from './SettingsContent';
import { SettingsSidebar } from './SettingsSidebar';

/**
 * 設定ダイアログ（PC用）
 *
 * ShellStore で開閉・カテゴリを管理。
 * URL は変更しない。サイドバーのカテゴリ切替も store 経由。
 */
export function SettingsDialog() {
  const t = useTranslations();
  const activeSheet = useShellStore((s) => s.activeSheet);
  const isOpen = activeSheet?.type === 'settings';
  const category = activeSheet?.type === 'settings' ? activeSheet.category : 'account';
  const close = useShellStore((s) => s.closeSheet);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        // eslint-disable-next-line tailwindcss/no-arbitrary-value -- viewport unit
        className="flex h-[85vh] max-h-200 max-w-4xl flex-col gap-0 overflow-hidden p-0 md:flex-row"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{t('settings.dialog.title')}</DialogTitle>
        </VisuallyHidden>
        <div className="border-border relative w-full shrink-0 border-b md:w-60 md:border-r md:border-b-0">
          <SettingsSidebar presentation="dialog" className="h-full" />
          <DialogClose className="text-muted-foreground hover:text-foreground hover:bg-state-hover active:bg-state-hover focus-visible:ring-ring absolute top-2 right-2 z-10 flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-hidden">
            <XIcon className="size-4" />
            <span className="sr-only">{t('common.actions.close')}</span>
          </DialogClose>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SettingsContent category={category} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
