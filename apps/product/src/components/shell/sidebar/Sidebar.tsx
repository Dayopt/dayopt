'use client';

import { CircleHelp, PanelLeft, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { useShellStore } from '@/lib/stores/useShellStore';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  HoverTooltip,
} from '@dayopt/components';
import { useTranslations } from 'next-intl';

import { HelpMenuItems, UserMenu } from './UserMenu';

interface SidebarProps {
  /** Sidebarのコンテンツ（composition layerから注入、スクロール領域） */
  children: ReactNode;
  /** UserMenu に表示するユーザー情報（composition layerから注入） */
  user: { name: string; email: string; avatar: string | null };
  /** ヘッダー左側（現在のワークスペース名。composition layerから注入） */
  headerTitle: ReactNode;
  /** フッターに配置するアクション（通知アイコン等） */
  footerActions?: ReactNode;
  /**
   * スクロール領域とフッターの間に固定表示するコンテンツ（MiniCalendar 等）。
   * スクロールに追従させず「プロフィールの上」に留めたい要素向け（#2217）。
   */
  pinnedContent?: ReactNode;
  /** ランドマークのアクセシブルネーム */
  'aria-label'?: string;
}

/** サイドバーのヘルプメニュー。#2248 の race 回帰 test から直接検証するため export する。 */
export function SidebarHelpMenu() {
  const t = useTranslations();

  return (
    <DropdownMenu>
      <HoverTooltip content={t('navigation.sidebar.getHelp')} side="top">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" icon size="sm" aria-label={t('navigation.sidebar.getHelp')}>
            <CircleHelp className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </HoverTooltip>
      <DropdownMenuContent
        className="border-input min-w-56"
        side="right"
        align="end"
        sideOffset={4}
        // DropdownMenu が閉じる際にデフォルトでは trigger へフォーカスを戻すが、
        // HelpMenuItems の onSelect は同じ tick で Dialog/Sheet（shortcutCheatSheet /
        // contact、いずれも modal=false）を開く。フォーカス復帰がその Dialog の
        // outside-interaction 検出と競合し、開いた直後に閉じてしまう（#2153 で
        // setTimeout 遅延の workaround を試みたが実機で再発、#2248 で根治）。
        // フォーカス復帰そのものを止めることで競合を起こさせない。
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <HelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** サイドバーコンテナ（ヘッダー + スクロール領域 + フッター） */
export function Sidebar({
  children,
  user,
  headerTitle,
  footerActions,
  pinnedContent,
  'aria-label': ariaLabel,
}: SidebarProps) {
  const closeSidebar = useShellStore.use.closeSidebar();
  const openTimeblockSearch = useShellStore.use.openTimeblockSearch();
  const t = useTranslations();

  return (
    <aside
      className="border-border bg-surface-container text-foreground group flex h-full w-full flex-col border-r"
      aria-label={ariaLabel}
    >
      {/* Header - ブランド名 + Close。AppHeader.tsx と高さを揃える（h-14） */}
      <div className="flex h-14 shrink-0 items-center justify-between px-2">
        <div className="flex min-w-0 items-center gap-2 pl-2">{headerTitle}</div>
        <div className="flex items-center gap-1">
          {/* 閉じるボタンはSidebarホバー時のみ表示（User指示）。キーボード操作でも
              見えるよう group-has-[:focus-visible] を併用する。focus-within だと
              マウスでクリックした後もフォーカスが残る間ずっと出しっぱなしになる */}
          <HoverTooltip content={t('navigation.sidebar.closeSidebar')} side="bottom">
            <Button
              variant="ghost"
              icon
              size="sm"
              onClick={closeSidebar}
              aria-label={t('navigation.sidebar.closeSidebar')}
              className="opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
            >
              <PanelLeft className="size-4" />
            </Button>
          </HoverTooltip>
        </div>
      </div>

      {/* Content */}
      {/* scrollbar-gutter-stable は付けない。旧「並び替えDnD」（@dnd-kit の
          sortable、ドラッグ中に折りたたみグループが自動展開される機構）向けの
          対策だったが、その機能自体が #2162 で廃止済み。現在のカテゴリー
          再割り当てDnD（ネイティブ HTML5）は自動展開を持たないため、この予約が
          守っていた実害はもう無い一方、行のホバー背景が右側だけ 11px ほど狭く
          見える実害が残っていた（2026-09-04 User 指摘・実測）。gutter 予約を
          外すことで解消する */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto">
        {children}
      </div>

      {/* Pinned（スクロールに追従しない。MiniCalendar 等。#2217） */}
      {pinnedContent && (
        <div className="border-border shrink-0 border-t px-2 pt-2">{pinnedContent}</div>
      )}

      {/* Footer - UserMenu + 検索 + Help。検索はUser指示によりヘッダーからここへ移動（ヘルプの左隣） */}
      <div className="shrink-0 px-2 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <UserMenu user={user} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {footerActions}
            <HoverTooltip content={t('calendar.search.open')} side="top">
              <Button
                variant="ghost"
                icon
                size="sm"
                onClick={openTimeblockSearch}
                aria-label={t('calendar.search.open')}
              >
                <Search className="size-4" />
              </Button>
            </HoverTooltip>
            <SidebarHelpMenu />
          </div>
        </div>
      </div>
    </aside>
  );
}
