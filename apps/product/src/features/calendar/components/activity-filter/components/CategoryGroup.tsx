'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { useLocale } from 'next-intl';

import type { Activity, Category } from '@/features/activities';
import { cn } from '@dayopt/components';

import { useActivityModalNavigation } from '../../../hooks/useActivityModalNavigation';
import { buildReportPath } from '../../../lib/panel-url';
import { useActivityDropTarget } from '../useActivityDragHandlers';

import { ActivityRow } from './ActivityRow';
import type { CategoryOption } from './ActivityRowMenu';
import { CategoryHeader } from './CategoryHeader';
import { useCategoryAppearanceEdit } from './useCategoryAppearanceEdit';

interface CategoryGroupProps {
  category: Category;
  activities: Activity[];
  allActivities: Activity[];
  visibleActivityIds: Set<string>;
  categoryOptions: CategoryOption[];
  collapsed: boolean;
  isMobile: boolean;
  onToggleCollapse: () => void;
  onToggleActivity: (activityId: string) => void;
  onShowOnlyActivity: (activityId: string) => void;
  onShowOnlyCategoryActivities: (activityIds: string[]) => void;
  getCategoryVisibility: (activityIds: string[]) => 'all' | 'none' | 'some';
  onArchiveCategory: (id: string) => void;
  onDeleteCategory: (id: string, name: string) => void;
  onArchiveActivity: (id: string) => void;
  onDeleteActivity: (id: string, name: string) => void;
}

/**
 * カテゴリー見出し + そこに所属するアクティビティのネスト表示。
 *
 * 見出しにチェックボックスは置かず、一括表示はメニューの
 * 「このカテゴリーだけ表示」で行う（確定仕様）。所属アクティビティは
 * カテゴリーの色とアイコンを継承する。
 */
export function CategoryGroup({
  category,
  activities,
  allActivities,
  visibleActivityIds,
  categoryOptions,
  collapsed,
  isMobile,
  onToggleCollapse,
  onToggleActivity,
  onShowOnlyActivity,
  onShowOnlyCategoryActivities,
  getCategoryVisibility,
  onArchiveCategory,
  onDeleteCategory,
  onArchiveActivity,
  onDeleteActivity,
}: CategoryGroupProps) {
  const locale = useLocale();
  const router = useRouter();
  const { openActivityCreateModal, openCategoryRenameModal } = useActivityModalNavigation();
  const { displayColor, handleColorChange, handleIconChange } = useCategoryAppearanceEdit({
    categoryId: category.id,
    initialColor: category.color ?? undefined,
  });

  const activityIds = useMemo(() => activities.map((activity) => activity.id), [activities]);
  const visibility = getCategoryVisibility(activityIds);
  const { isActiveTarget, dropProps } = useActivityDropTarget(category.id);

  const handleViewStats = useCallback(() => {
    // カレンダー内パネル（CalendarReviewRail）は廃止済み（#2181 Step 4）。
    // アクティビティによるセグメント絞り込みは Step 5（セグメント配線）で復元する。
    router.push(buildReportPath(locale, new Date()));
  }, [router, locale]);

  return (
    // カテゴリー間の余白は自分の開閉状態で決める（自分の下に margin-bottom）。
    // 開いている時だけ 8px（グループ内 4px の 2 倍あれば境目は読める。
    // 2026-09-03 User 判断。一度 16px / 12px を試して広すぎた）。閉じて並んでいる
    // 時は詰める（2026-09-04 User 指示）。最後の 1 件は次に何も続かないので
    // last:mb-0 で常に 0 にする
    //
    // drop target は見出しだけでなくこの箱ごと。中の行は自前の drop 判定を
    // 持たないので、配下の行の上に乗っていてもこのカテゴリーへの drop になる
    // （並び替えを持たない以上それが正しく、ネストによるちらつきも消える）
    <div
      className={cn(
        'w-full min-w-0 rounded-lg',
        !collapsed && 'mb-2',
        'last:mb-0',
        // ドロップ先の切り替えはカーソル追従なので、fade を入れると遅れて見える
        isActiveTarget && 'bg-state-hover ring-ring ring-2 transition-none ring-inset',
      )}
      {...dropProps}
    >
      <CategoryHeader
        label={category.name}
        visibility={visibility}
        collapsed={collapsed}
        displayColor={displayColor}
        currentIcon={category.icon}
        isMobile={isMobile}
        onToggleCollapse={onToggleCollapse}
        onShowOnlyCategory={() => onShowOnlyCategoryActivities(activityIds)}
        onColorChange={handleColorChange}
        onIconChange={handleIconChange}
        onAddActivityToCategory={() => openActivityCreateModal({ initialCategoryId: category.id })}
        onRenameCategory={() => openCategoryRenameModal({ id: category.id, name: category.name })}
        onViewStats={handleViewStats}
        onArchiveCategory={() => onArchiveCategory(category.id)}
        onDeleteCategory={() => onDeleteCategory(category.id, category.name)}
      />

      {/* ml-6: 見出しのアイコン + テキストぶんの字下げ（実測 32px）に子行のテキストを
          揃える。子行はアイコンを持たず、自身の ml-2 だけを引いた分をここで足す */}
      {!collapsed ? (
        <div role="list" className="mt-1 ml-6">
          {activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              allActivities={allActivities}
              checked={visibleActivityIds.has(activity.id)}
              categoryId={category.id}
              categoryOptions={categoryOptions.filter((option) => option.id !== category.id)}
              isMobile={isMobile}
              onToggle={() => onToggleActivity(activity.id)}
              onArchiveActivity={() => onArchiveActivity(activity.id)}
              onDeleteActivity={() => onDeleteActivity(activity.id, activity.name)}
              onShowOnlyActivity={() => onShowOnlyActivity(activity.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
