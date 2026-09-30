'use client';

import { BarChart3, CalendarDays } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { IconTabSwitcher } from '@/components/ui/navigation/IconTabSwitcher';
import { formatCalendarDateParam, useCalendarNavigation } from '@/features/calendar';
import { usePathname } from '@dayopt/i18n/navigation';

import { getWorkspaceTabFromPath } from './workspace-tabs';

/**
 * Sidebar ヘッダー行（カレンダー / レポート切替）の状態を集約する hook。
 *
 * タブ href は現在の日付（と calendar タブなら view）を引き継ぐ。これが
 * タブ往復で日付・view が保たれる仕組みの本体（overview.md §6-9 #1）。
 * `useSearchParams()` は使わない（§5-3 と同じ理由）。
 */
function useWorkspaceTabsState() {
  const t = useTranslations();
  const pathname = usePathname();
  const navigation = useCalendarNavigation();

  const currentTab = getWorkspaceTabFromPath(pathname);
  const date = navigation ? formatCalendarDateParam(navigation.currentDate) : undefined;
  const view = navigation?.viewType ?? 'week';
  const isViewReady = navigation?.isViewReady !== false;

  const calendarHref = date ? `/calendar?view=${view}&date=${date}` : `/calendar?view=${view}`;
  const reportHref = date ? `/report?date=${date}` : '/report';
  const calendarLabel = t('sidebar.pageNav.calendar');
  const reportLabel = t('sidebar.pageNav.report');

  return { currentTab, calendarHref, reportHref, calendarLabel, reportLabel, isViewReady };
}

/**
 * Sidebar ヘッダーの左側に置く、現在のワークスペース名（カレンダー / レポート）。
 * 旧来の固定表記「Dayopt」の代わりに、現在地を示す動的タイトルとして使う。
 */
export function WorkspaceTitle() {
  const { currentTab, calendarLabel, reportLabel } = useWorkspaceTabsState();

  return (
    <span className="text-foreground truncate text-base font-medium tracking-tight">
      {currentTab === 'report' ? reportLabel : calendarLabel}
    </span>
  );
}

/**
 * Sidebar ヘッダーの右側に置く、カレンダー / レポート切替アイコン。
 *
 * 見た目と当たり判定は共有の `IconTabSwitcher` が持つ（レポートの粒度タブと同じ部品）。
 * ここが受け持つのは「どの href を指すか」だけ。
 */
export function WorkspaceTabs() {
  const t = useTranslations();
  const { currentTab, calendarHref, reportHref, calendarLabel, reportLabel, isViewReady } =
    useWorkspaceTabsState();

  return (
    <IconTabSwitcher
      ariaLabel={t('sidebar.pageNav.label')}
      // `other`（/settings 等）では**どちらも選択しない**。'calendar' に丸めると、
      // カレンダーを見ていないのにカレンダータブが選択済みに見える（2026-09-07 の反証レビュー指摘）
      value={currentTab === 'calendar' || currentTab === 'report' ? currentTab : undefined}
      items={[
        {
          value: 'calendar',
          label: calendarLabel,
          href: isViewReady ? calendarHref : undefined,
          disabled: !isViewReady,
          icon: <CalendarDays className="size-4" />,
        },
        {
          value: 'report',
          label: reportLabel,
          href: reportHref,
          icon: <BarChart3 className="size-4" />,
        },
      ]}
    />
  );
}
