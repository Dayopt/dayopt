'use client';

import { Archive, Check, Eye, FolderUp, Pencil, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ActivityIcon } from '@/features/activities';
import {
  cn,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@dayopt/components';

import { ActivityDetailsMenuItem } from './ActivityDetailsMenuItem';

/** カテゴリー選択肢（「カテゴリーを変更」ピッカーの 1 行） */
export interface CategoryOption {
  id: string;
  name: string;
  color: string | null;
  icon?: string | null;
}

interface ActivityRowMenuProps {
  /** 現在の所属カテゴリー ID（null = 未分類） */
  currentCategoryId: string | null;
  /** カテゴリー候補一覧 */
  categoryOptions: CategoryOption[];
  /** モバイル時: メニュー項目を簡略化（表示切替 + アーカイブ + 削除のみ） */
  isMobile?: boolean | undefined;

  onOpenRenameDialog: () => void;
  onChangeCategory: (categoryId: string | null) => void;
  onShowOnlyActivity: () => void;
  onViewActivityDetails?: (() => void) | undefined;
  onArchiveActivity?: (() => void) | undefined;
  onDeleteActivity?: (() => void) | undefined;
}

/**
 * アクティビティ行のドロップダウンメニュー。
 *
 * DnD 廃止に伴い、カテゴリーの付け替えは「カテゴリーを変更」→ ピッカーで行う。
 * 色・アイコンはカテゴリーだけが持つため、この menu には色/アイコン変更を置かない。
 * 統合（マージ）も v1 では持たない（#2162 §4-8）。
 */
export function ActivityRowMenu({
  currentCategoryId,
  categoryOptions,
  isMobile,
  onOpenRenameDialog,
  onChangeCategory,
  onShowOnlyActivity,
  onViewActivityDetails,
  onArchiveActivity,
  onDeleteActivity,
}: ActivityRowMenuProps) {
  const t = useTranslations();

  // モバイル: 表示切替 + アーカイブ + 削除のみ。管理系は設定画面へ委譲。
  // アーカイブはこのメニューが唯一の UI 呼び出し元のため、モバイルでも省略しない（#1576）。
  if (isMobile) {
    return (
      <DropdownMenuContent align="start" side="right">
        <DropdownMenuItem onClick={onShowOnlyActivity}>
          <Eye className="size-4" />
          {t('calendar.filter.showOnlyThisActivity')}
        </DropdownMenuItem>
        {onViewActivityDetails && (
          <ActivityDetailsMenuItem onViewActivityDetails={onViewActivityDetails} />
        )}
        {onArchiveActivity && (
          <DropdownMenuItem onClick={onArchiveActivity}>
            <Archive className="size-4" />
            {t('calendar.filter.archive')}
          </DropdownMenuItem>
        )}
        {onDeleteActivity && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDeleteActivity}>
              <Trash2 className="size-4" />
              {t('common.actions.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    );
  }

  return (
    <DropdownMenuContent align="start" side="right">
      <DropdownMenuItem onClick={onOpenRenameDialog}>
        <Pencil className="size-4" />
        {t('calendar.filter.rename')}
      </DropdownMenuItem>

      {/* カテゴリーを変更（DnD の代替導線） */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <FolderUp className="size-4" />
          {t('calendar.filter.changeCategory')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            onClick={() => onChangeCategory(null)}
            className={currentCategoryId === null ? 'bg-state-selected' : undefined}
          >
            <X className="text-muted-foreground size-4" />
            <span className="flex-1">{t('calendar.filter.noCategory')}</span>
            {currentCategoryId === null && <Check className="text-muted-foreground ml-2 size-4" />}
          </DropdownMenuItem>

          {categoryOptions.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {categoryOptions.map((category) => {
                const isCurrent = currentCategoryId === category.id;
                return (
                  <DropdownMenuItem
                    key={category.id}
                    onClick={() => onChangeCategory(category.id)}
                    className={cn(isCurrent ? 'bg-state-selected' : undefined)}
                  >
                    <ActivityIcon
                      icon={category.icon}
                      color={category.color}
                      size="sm"
                      className="shrink-0"
                    />
                    <span className="flex-1">{category.name}</span>
                    {isCurrent && <Check className="text-muted-foreground ml-2 size-4" />}
                  </DropdownMenuItem>
                );
              })}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />

      {/* 統合（マージ）は v1 で持たない（#2162 §4-8）。重複は改名 + アーカイブで代替する */}
      <DropdownMenuItem onClick={onShowOnlyActivity}>
        <Eye className="size-4" />
        {t('calendar.filter.showOnlyThisActivity')}
      </DropdownMenuItem>

      {onViewActivityDetails && (
        <ActivityDetailsMenuItem onViewActivityDetails={onViewActivityDetails} />
      )}

      {/* アーカイブ（可逆なので確認なし） */}
      {onArchiveActivity && (
        <DropdownMenuItem onClick={onArchiveActivity}>
          <Archive className="size-4" />
          {t('calendar.filter.archive')}
        </DropdownMenuItem>
      )}

      {onDeleteActivity && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDeleteActivity}>
            <Trash2 className="size-4" />
            {t('common.actions.delete')}
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
