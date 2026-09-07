'use client';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';

import { Toaster } from '@/components/ui/feedback/toast';
import { ShortcutCheatSheetDialog } from '@/components/ui/overlays/shortcut-cheat-sheet-dialog';
import {
  buildReportPath,
  InlineCreatePanel,
  isCalendarViewPath,
  useCalendarNavigation,
  useShortcutRegistry,
  useTimeblockClipboardStore,
  useTimeblockSearchShortcut,
} from '@/features/calendar';
import { useTimeblockInspectorStore, type ClipboardTimeblock } from '@/features/timeblock';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useShellStore } from '@/lib/stores/useShellStore';
import { toast } from '@/lib/toast';
import { APP_SHORTCUT_CATALOG } from './app-shortcut-catalog';
import { useTimeblockSearchResultNavigation } from './useTimeblockSearchResultNavigation';

const ContactDialog = dynamic(
  () =>
    import('@/features/contact').then((m) => ({
      default: m.ContactDialog,
    })),
  { ssr: false },
);

const SettingsDialog = dynamic(
  () =>
    import('@/features/settings/components/SettingsDialog').then((m) => ({
      default: m.SettingsDialog,
    })),
  { ssr: false },
);

const TimeblockInspector = dynamic(
  () =>
    import('@/features/timeblock/components/editor/TimeblockInspector').then((m) => ({
      default: m.TimeblockInspector,
    })),
  { ssr: false },
);

const TimeblockSearchDialog = dynamic(
  () =>
    import('@/features/calendar/components/search/TimeblockSearchDialog').then((m) => ({
      default: m.TimeblockSearchDialog,
    })),
  { ssr: false },
);

/**
 * グローバルオーバーレイ群
 *
 * アプリ全体で共有されるダイアログ・トースト。
 * layout.tsx から分離し、追加/削除を一箇所で管理する。
 */
export function GlobalOverlays() {
  useShortcutRegistry();
  useTimeblockSearchShortcut();

  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const calendarNavigation = useCalendarNavigation();
  const timezone = useUserPreferences((preferences) => preferences.timezone);

  const activeSheet = useShellStore.use.activeSheet();
  const closeSheet = useShellStore.use.closeSheet();
  const openTimeblockSearch = useShellStore.use.openTimeblockSearch();
  const closeTimeblockSearch = useShellStore.use.closeTimeblockSearch();
  const contactOpen = activeSheet?.type === 'contact';
  const settingsOpen = activeSheet?.type === 'settings';
  const timeblockSearchOpen = activeSheet?.type === 'timeblockSearch';
  const shortcutCheatSheetOpen = activeSheet?.type === 'shortcutCheatSheet';
  // ShortcutCheatSheetDialog は components/ 配下のため features/calendar の
  // isCalendarViewPath を直接importできない（依存方向違反）。ここで判定して渡す。
  const shortcutActiveScope = isCalendarViewPath(pathname?.replace(/^\/(ja|en)/, '') ?? '')
    ? 'calendar'
    : 'global';
  const isInspectorOpen = useTimeblockInspectorStore((s) => s.isOpen);
  const closeInspector = useTimeblockInspectorStore((s) => s.closeInspector);
  const copyTimeblock = useTimeblockClipboardStore((state) => state.copyTimeblock);

  // shell overlayが開いたら Inspector を閉じる（排他制御）
  useEffect(() => {
    if (settingsOpen || contactOpen || timeblockSearchOpen || shortcutCheatSheetOpen) {
      closeInspector();
    }
  }, [settingsOpen, contactOpen, timeblockSearchOpen, shortcutCheatSheetOpen, closeInspector]);

  // Inspector は Calendar ビュー専用 — workspace ビュー外への遷移で自動 close。
  // `/calendar` への集約済み（isCalendarViewPath で判定）。
  useEffect(() => {
    if (!isInspectorOpen) return;
    const pathWithoutLocale = pathname?.replace(/^\/(ja|en)/, '') ?? '';
    if (!isCalendarViewPath(pathWithoutLocale)) {
      closeInspector();
    }
  }, [pathname, isInspectorOpen, closeInspector]);

  // Inspector → /report。カレンダー内パネル（CalendarReviewRail）は廃止済み
  // （#2181 Step 4）。アクティビティによるセグメント絞り込みは Step 5（セグメント配線）で
  // 復元する（旧 docs/projects/_archive/workspace-shell-restructure/overview.md §6-5、
  // docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
  const handleViewStats = useCallback(
    (activityId: string) => {
      void activityId;
      router.push(buildReportPath(locale, new Date()));
      closeInspector();
    },
    [closeInspector, router, locale],
  );

  const handleCopy = useCallback(
    (timeblock: ClipboardTimeblock) => {
      copyTimeblock(timeblock);
      toast.success(t('common.toast.copied'));
    },
    [copyTimeblock, t],
  );

  const handleSearchOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openTimeblockSearch();
      } else {
        closeTimeblockSearch();
      }
    },
    [closeTimeblockSearch, openTimeblockSearch],
  );

  const handleOpenSearchResult = useTimeblockSearchResultNavigation({
    calendarNavigation,
    locale,
    timezone,
    timeblockSearchOpen,
    isInspectorOpen,
  });

  return (
    <>
      <ContactDialog
        open={contactOpen}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
      />
      <SettingsDialog />
      <TimeblockSearchDialog
        open={timeblockSearchOpen}
        onOpenChange={handleSearchOpenChange}
        onOpenResult={handleOpenSearchResult}
      />
      <ShortcutCheatSheetDialog
        open={shortcutCheatSheetOpen}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        catalog={APP_SHORTCUT_CATALOG}
        activeScope={shortcutActiveScope}
      />
      <TimeblockInspector
        onViewStats={handleViewStats}
        onCopy={handleCopy}
        createContent={<InlineCreatePanel onClose={closeInspector} />}
      />
      <Toaster />
    </>
  );
}
