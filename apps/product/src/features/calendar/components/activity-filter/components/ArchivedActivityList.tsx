'use client';

import { useMemo } from 'react';

import { ArchiveRestore, MoreHorizontal, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SidebarIconButton } from '@/components/shell/sidebar';
import { ErrorState } from '@/components/ui/feedback/ErrorState';
import {
  useArchivedActivities,
  useArchivedCategories,
  useRestoreActivity,
  useRestoreCategory,
} from '@/features/activities';
import { useProductAccessGate } from '@/lib/billing/useProductAccessGate';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dayopt/components';

interface ArchivedActivityListProps {
  /**
   * 完全削除フロー（確認ダイアログ）は親のハンドラに委ねる。
   * アクティビティとカテゴリーで削除の影響が違う（前者は予定・記録がアクティビティ
   * なしになり、後者は所属アクティビティが未分類になる）ため、経路を分ける。
   */
  onDeleteActivity: (id: string, name: string) => void;
  onDeleteCategory: (id: string, name: string) => void;
}

/** 一覧に並べる 1 行。復元先の mutation が違うので種別を持たせる */
interface ArchivedEntry {
  kind: 'activity' | 'category';
  id: string;
  name: string;
}

/**
 * アーカイブ済みのアクティビティ / カテゴリー一覧（行のみ）。
 *
 * **アクティビティとカテゴリーの両方**を並べる。片方だけにすると、もう片方は
 * 復元も完全削除もできなくなる（サイドバー本体はアーカイブ済みを出さないため、
 * ここが唯一の入口）。
 *
 * 見出し・件数・折りたたみは持たない。「未分類」見出しの中に置かれ、表示するかどうかと
 * 状態（アクティブ / アーカイブ / すべて）は呼び出し側の表示メニューが一元管理する
 * （2026-08-18 User 指示、ラベル行は冗長として撤去）。
 *
 * 1 件も無ければ何も描画しない。
 */
export function ArchivedActivityList({
  onDeleteActivity,
  onDeleteCategory,
}: ArchivedActivityListProps) {
  const t = useTranslations();

  const {
    data: archivedActivities,
    isError: isActivitiesError,
    refetch: refetchActivities,
  } = useArchivedActivities();
  const {
    data: archivedCategories,
    isError: isCategoriesError,
    refetch: refetchCategories,
  } = useArchivedCategories();

  const restoreActivity = useRestoreActivity();
  const restoreCategory = useRestoreCategory();
  // restore は利用権無しで server が拒否する（delete は許す）。送る前に止める
  const gateProductAccess = useProductAccessGate();

  // カテゴリーを先に出す。アクティビティの所属先なので、復元の順序としても自然
  const entries = useMemo<ArchivedEntry[]>(
    () => [
      ...(archivedCategories ?? []).map((category) => ({
        kind: 'category' as const,
        id: category.id,
        name: category.name,
      })),
      ...(archivedActivities ?? []).map((activity) => ({
        kind: 'activity' as const,
        id: activity.id,
        name: activity.name,
      })),
    ],
    [archivedCategories, archivedActivities],
  );

  const isError = isActivitiesError || isCategoriesError;

  if (isError) {
    return (
      <div className="w-full min-w-0">
        <ErrorState
          title={t('calendar.filter.archivedLoadFailed')}
          onRetry={() => {
            void refetchActivities();
            void refetchCategories();
          }}
          size="sm"
        />
      </div>
    );
  }

  if (entries.length === 0) return null;

  return (
    <div className="w-full min-w-0">
      <div role="list" className="space-y-1">
        {entries.map((entry) => (
          <div
            key={`${entry.kind}-${entry.id}`}
            role="listitem"
            className="group/item hover:bg-state-hover flex h-8 w-full min-w-0 items-center rounded-lg text-sm"
          >
            {/* アイコンは出さない。通常のアクティビティ行と同じ見せ方にし、
                色（text-muted-foreground）だけで区別する（2026-08-18 User 指示） */}
            <span className="text-muted-foreground ml-2 min-w-0 flex-1 truncate">{entry.name}</span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarIconButton
                  aria-label={
                    entry.kind === 'category'
                      ? t('calendar.filter.categoryMenu')
                      : t('calendar.filter.activityMenu')
                  }
                  className="mr-1"
                  revealOn="item"
                >
                  <MoreHorizontal className="size-4" />
                </SidebarIconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem
                  onClick={() =>
                    gateProductAccess(() =>
                      entry.kind === 'category'
                        ? restoreCategory.mutate({ id: entry.id })
                        : restoreActivity.mutate({ id: entry.id }),
                    )
                  }
                >
                  <ArchiveRestore className="size-4" />
                  {t('calendar.filter.restore')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() =>
                    entry.kind === 'category'
                      ? onDeleteCategory(entry.id, entry.name)
                      : onDeleteActivity(entry.id, entry.name)
                  }
                >
                  <Trash2 className="size-4" />
                  {t('common.actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
    </div>
  );
}
