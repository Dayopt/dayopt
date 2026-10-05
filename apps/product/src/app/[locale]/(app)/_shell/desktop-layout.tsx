'use client';

import { PanelLeft } from 'lucide-react';
import { useCallback } from 'react';

import { AnimatedWidthPanel } from '@/components/shell/AnimatedWidthPanel';
import { AppHeader } from '@/components/shell/AppHeader';
import { Sidebar } from '@/components/shell/sidebar';
import {
  ACTIVITY_DETAIL_PANEL_DEFAULT_WIDTH,
  ACTIVITY_DETAIL_SLOT_KEY,
} from '@/features/activities';
import { useAuthStore } from '@/features/auth';
import { isCalendarViewPath } from '@/features/calendar';
import { TIMEBLOCK_INSPECTOR_SLOT_KEY, useTimeblockInspectorStore } from '@/features/timeblock';
import { setDomSlot } from '@/lib/dom-slots/useDomSlot';
import { getAvatarUrl, getDisplayName } from '@/lib/user';
import { Button, InlineBanner } from '@dayopt/components';
import { usePathname } from '@dayopt/i18n/navigation';

import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';
import { useShellStore } from '@/lib/stores/useShellStore';

import { MainContentWrapper } from './main-content-wrapper';
import { SidebarContent } from './SidebarContent';
import { SidebarPinnedContent } from './SidebarPinnedContent';
import { useAppInlineBanner } from './useAppInlineBanner';

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
 * - Activity detail（既定幅 360px。カレンダーから明示的に開いた時のみ表示）
 *
 * **右のパネルは 2 枚とも DOM 上に常に存在する**（`AnimatedWidthPanel` が幅 0 で畳む）。
 * Inspector とアクティビティ詳細は GlobalOverlays で相互排他にする。
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
  const isActivityDetailOpen = useActivityDetailStore((s) => s.isOpen);
  const setActivityDetailSlot = useCallback((element: HTMLDivElement | null) => {
    setDomSlot(ACTIVITY_DETAIL_SLOT_KEY, element);
  }, []);
  const sidebarUser = {
    name: getDisplayName(authUser, 'User'),
    email: authUser?.email || '',
    avatar: getAvatarUrl(authUser),
  };

  // カレンダーは独自ヘッダーを持つ。その他の app pages は AppHeader を使う。
  const hasOwnHeader = isCalendarViewPath(pathname);
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
            headerTitle={
              <span className="text-foreground truncate text-base font-medium tracking-tight">
                Dayopt
              </span>
            }
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

        {/* Activity detail（カレンダーから明示的に開いた時のみ表示） */}
        <AnimatedWidthPanel
          data-panel="activity-detail"
          open={isActivityDetailOpen}
          width={ACTIVITY_DETAIL_PANEL_DEFAULT_WIDTH}
          side="right"
          className="border-border h-full border-l"
          innerClassName="h-full"
        >
          <div ref={setActivityDetailSlot} className="h-full" />
        </AnimatedWidthPanel>
      </div>
    </div>
  );
}
