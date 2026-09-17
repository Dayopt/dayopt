'use client';

import { PanelLeft } from 'lucide-react';
import { useCallback } from 'react';

import { AnimatedWidthPanel } from '@/components/shell/AnimatedWidthPanel';
import { AppHeader } from '@/components/shell/AppHeader';
import { Sidebar } from '@/components/shell/sidebar';
import { useAuthStore } from '@/features/auth';
import { isCalendarViewPath, resolveWorkspaceTab } from '@/features/calendar';
import { REPORT_DETAIL_SLOT_KEY, useReportDetailStore } from '@/features/review';
import { TIMEBLOCK_INSPECTOR_SLOT_KEY, useTimeblockInspectorStore } from '@/features/timeblock';
import { setDomSlot } from '@/lib/dom-slots/useDomSlot';
import { getAvatarUrl, getDisplayName } from '@/lib/user';
import { Button, InlineBanner } from '@dayopt/components';
import { usePathname } from '@dayopt/i18n/navigation';

import { useShellStore } from '@/lib/stores/useShellStore';

import { MainContentWrapper } from './main-content-wrapper';
import { SidebarContent } from './SidebarContent';
import { SidebarPinnedContent } from './SidebarPinnedContent';
import { useAppInlineBanner } from './useAppInlineBanner';
import { WorkspaceTabs, WorkspaceTitle } from './WorkspaceTabs';

interface DesktopLayoutProps {
  children: React.ReactNode;
}

/** Inspector ドッキングパネルの幅（px）。リサイズは非対応（v1 は固定幅）。 */
const INSPECTOR_PANEL_WIDTH = 400;

/**
 * デスクトップ用レイアウト
 *
 * 3カラムレイアウト:
 * - Sidebar（256px、開閉可能）← 全ページ共通 Sidebar
 * - PageHeader + MainContent
 * - Inspector（400px、Timeblock 選択時のみ開く。@/features/timeblock が portal で描画）
 * - Report detail（既定 360px・250〜560px で可変。`/report` で行・点を選んだ時のみ開く。
 *   @/features/review が portal で描画し、幅は review の store が持つ）
 *
 * **右のパネルは 2 枚とも DOM 上に常に存在する**（`AnimatedWidthPanel` が幅 0 で畳む）が、
 * inspector はカレンダー、report detail はレポートに属するので同時には開かない。slot を
 * 共有せず 2 枚並べているのは、調停ロジックを shell に置かないため（#2581）。
 */
export function DesktopLayout({ children }: DesktopLayoutProps) {
  const pathname = usePathname();
  const sidebar = useShellStore.use.sidebar();
  const sidebarSuppressed = useShellStore.use.sidebarSuppressed();
  const banner = useAppInlineBanner();
  const toggleSidebar = useShellStore.use.toggleSidebar();
  const title = useShellStore.use.pageTitle();
  const authUser = useAuthStore((s) => s.user);
  const isInspectorOpen = useTimeblockInspectorStore((s) => s.isOpen);
  const setInspectorSlot = useCallback((element: HTMLDivElement | null) => {
    setDomSlot(TIMEBLOCK_INSPECTOR_SLOT_KEY, element);
  }, []);
  const isReportDetailOpen = useReportDetailStore((s) => s.isOpen);
  const reportDetailWidth = useReportDetailStore((s) => s.width);
  const isReportDetailResizing = useReportDetailStore((s) => s.isResizing);
  const setReportDetailSlot = useCallback((element: HTMLDivElement | null) => {
    setDomSlot(REPORT_DETAIL_SLOT_KEY, element);
  }, []);
  const sidebarUser = {
    name: getDisplayName(authUser, 'User'),
    email: authUser?.email || '',
    avatar: getAvatarUrl(authUser),
  };

  // ページ判定: 独自ヘッダーを持つページかどうか（AppHeader表示制御用）。
  // `/report` も自前で AppHeader を組む（期間ラベル・`‹ ›`・粒度切替を持つため、#2575）。
  // サイドバートグルは ReportViewClient が leftSlot へ渡し直す。
  const hasOwnHeader = isCalendarViewPath(pathname) || resolveWorkspaceTab(pathname) === 'report';
  const sidebarVisible = sidebar.open && !sidebarSuppressed;

  // サイドバーが閉じているときに表示するトグルボタン
  const sidebarToggle = !sidebar.open ? (
    <Button
      type="button"
      variant="ghost"
      icon
      size="sm"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <PanelLeft className="size-4" />
    </Button>
  ) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        {/* Sidebar（固定幅256px、開閉可能） */}
        <AnimatedWidthPanel
          open={sidebarVisible}
          width={sidebar.width}
          className="h-full"
          innerClassName="h-full"
        >
          <Sidebar
            user={sidebarUser}
            headerTitle={<WorkspaceTitle />}
            headerTabs={<WorkspaceTabs />}
            pinnedContent={<SidebarPinnedContent />}
          >
            <SidebarContent />
          </Sidebar>
        </AnimatedWidthPanel>

        {/* PageHeader + Main Content */}
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* AppHeader（Calendar は独自ヘッダーを持つため非表示） */}
          {!hasOwnHeader && (
            <AppHeader leftSlot={sidebarToggle}>
              {title && <h1 className="truncate text-lg leading-8 font-medium">{title}</h1>}
            </AppHeader>
          )}

          {/* インラインバナー（自前ヘッダーを持つ画面を含む全ページ共通） */}
          <InlineBanner {...banner} />

          {/* Main Content（自動的に残りのスペースを使用） */}
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="relative flex h-full min-h-0 flex-col">
              <MainContentWrapper>{children}</MainContentWrapper>
            </div>
          </div>
        </div>

        {/* Inspector（固定幅、Timeblock 選択時のみ開く） */}
        <AnimatedWidthPanel
          data-panel="timeblock-inspector"
          open={isInspectorOpen}
          width={INSPECTOR_PANEL_WIDTH}
          side="right"
          className="border-border h-full border-l"
          innerClassName="h-full"
        >
          <div ref={setInspectorSlot} className="h-full" />
        </AnimatedWidthPanel>

        {/* Report detail（可変幅、`/report` で行・点を選んだ時のみ開く） */}
        <AnimatedWidthPanel
          data-panel="report-detail"
          open={isReportDetailOpen}
          width={reportDetailWidth}
          // ドラッグ中は補間を切る。200ms の追従だと指の位置とパネルの端がずれる
          disableTransition={isReportDetailResizing}
          side="right"
          className="border-border h-full border-l"
          innerClassName="h-full"
        >
          <div ref={setReportDetailSlot} className="h-full" />
        </AnimatedWidthPanel>
      </div>
    </div>
  );
}
