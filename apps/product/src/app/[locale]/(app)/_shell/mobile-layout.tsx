'use client';

import { AppHeader } from '@/components/shell/AppHeader';
import { ActivityChipRow, isCalendarViewPath } from '@/features/calendar';
import { useShellStore } from '@/lib/stores/useShellStore';
import { InlineBanner } from '@dayopt/components';
import { usePathname } from '@dayopt/i18n/navigation';

import { ConnectedMobileAccountButton } from './MobileAccountButton';
import { useAppInlineBanner } from './useAppInlineBanner';

import { MainContentWrapper } from './main-content-wrapper';

interface MobileLayoutProps {
  children: React.ReactNode;
}

/**
 * モバイル用レイアウト
 *
 * **構成**:
 * - AppHeader（ナビゲーション。カレンダーと settings は自前のヘッダーを持つため、ここでは出さない）
 * - MainContent
 * - 固定バー群（画面下端。overview.md §5-7-b）: ActivityChipRow（Calendar
 *   タブのみ）。`pb-safe` はこのバー自身に付ける
 *
 * 本文の余白は固定トークン（動的測定なし）で、home calendar だけ
 * ActivityChipRow 1 段分を確保する。
 */
export function MobileLayout({ children }: MobileLayoutProps) {
  const title = useShellStore.use.pageTitle();
  const banner = useAppInlineBanner();

  const pathname = usePathname();

  const isCalendarView = isCalendarViewPath(pathname);

  const hasOwnHeader =
    isCalendarView || pathname === '/settings' || pathname.startsWith('/settings/');

  return (
    <>
      {/* AppHeader + Main Content */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {/* AppHeader（Calendar は独自ヘッダーを持つため非表示）
            sticky: スクロール祖先の先頭に固定する（calendar 側の実装と揃える） */}
        {!hasOwnHeader && (
          <div className="bg-background sticky top-0 z-20">
            <AppHeader
              rightSlot={
                <div className="flex h-8 items-center gap-1">
                  <ConnectedMobileAccountButton />
                </div>
              }
            >
              {title && <h1 className="truncate text-lg leading-8 font-medium">{title}</h1>}
            </AppHeader>
          </div>
        )}

        {/* インラインバナー（自前ヘッダーを持つ画面を含む全ページ共通） */}
        <InlineBanner {...banner} />

        {/* Main Content: calendar タブは ActivityChipRow 1段分の余白を確保する
            （固定トークン、動的測定なし）。それ以外は固定バーが無いため余白不要 */}
        <MainContentWrapper {...(isCalendarView ? { className: 'pb-16' } : {})}>
          {children}
        </MainContentWrapper>
      </div>

      {/* calendar タブのみ: ActivityChipRow を画面下端に固定。
          pb-safe はこのバー自身に付ける */}
      {isCalendarView && (
        <div className="bg-surface-container border-border-subtle z-bottom-tab pb-safe fixed inset-x-0 bottom-0 flex flex-col border-t">
          <ActivityChipRow />
        </div>
      )}
    </>
  );
}
