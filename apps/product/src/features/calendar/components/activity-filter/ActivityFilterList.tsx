'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Archive, ArrowDownUp, Plus, Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ActivitySortKey } from '@/features/calendar/stores/useActivitySortStore';
import { useActivitySortStore } from '@/features/calendar/stores/useActivitySortStore';
import { useCalendarFilterStore } from '@/features/calendar/stores/useCalendarFilterStore';

import { SidebarSection } from '@/components/shell/sidebar';
import type { ActivityTree } from '@/features/activities';
import {
  ActivityDeleteConfirmDialog,
  collectActivitiesFromTree,
  collectActivityIdsFromTree,
  useActivityTree,
  useArchiveActivity,
  useArchiveCategory,
  useArchivedActivities,
  useArchivedCategories,
  useDeleteActivity,
  useDeleteCategory,
} from '@/features/activities';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { api } from '@/lib/trpc';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverTooltip,
  Skeleton,
} from '@dayopt/components';

import { useActivityModalNavigation } from '../../hooks/useActivityModalNavigation';

import { mergeActivityDeleteCounts } from './activity-delete-counts';
import { ActivityDragProvider } from './ActivityDragContext';
import { ActivityRow } from './components/ActivityRow';
import type { CategoryOption } from './components/ActivityRowMenu';
import { ArchivedActivityList } from './components/ArchivedActivityList';
import { CategoryCreateDialog } from './components/CategoryCreateDialog';
import { CategoryGroup } from './components/CategoryGroup';
import { UncategorizedDropZone } from './components/UncategorizedDropZone';
import { sortActivities } from './sort-activities';

const EMPTY_CATEGORIES: ActivityTree['categories'] = [];
const EMPTY_ACTIVITIES: ActivityTree['uncategorized'] = [];
/** サブメニューの見出しに出す現在値のラジオ項目と同じ文言（i18n キーを二重に持たない） */
const STATUS_LABEL_KEYS = {
  all: 'calendar.filter.statusAll',
  active: 'calendar.filter.statusActive',
  archived: 'calendar.filter.statusArchived',
} as const;

const SORT_LABEL_KEYS = {
  name: 'calendar.filter.sortByName',
  lastUsed: 'calendar.filter.sortByLastUsed',
} as const;

/** stats 未取得時に毎 render で新しい object を作らないための固定値 */
const EMPTY_LAST_USED: Record<string, string> = {};

/**
 * サイドバーのアクティビティ一覧。
 *
 * IA（確定仕様）:
 * 1. カテゴリー見出し（色 + アイコン + 折りたたみ、既定は展開）→ 所属アクティビティをネスト
 * 2. 「未分類」見出し → カテゴリー未所属のアクティビティをテキストのみで列挙
 * 3. 「アーカイブ済み」折りたたみ
 *
 * アクティビティ未設定のブロックのフィルタ行は置かない（2026-08-18 User 指示）。
 * それらのブロックは常に表示される。
 *
 * 並び順はサーバーの `listTree` が名前順で返す（`sort_order` は持たない）。
 * **並び替えの DnD は廃止したままで、復活させない**（#2162）。
 *
 * 一方で「所属を変えるための DnD」は持つ: 行を別のカテゴリー群 / 未分類へ
 * ドラッグすると `category_id` が変わる（`ActivityDragContext`）。順序は
 * 名前順のまま変わらないので、`sort_order` の議論には戻らない。
 * キーボード経路として行メニューの「カテゴリーを変更」も残す。
 */
interface ActivityFilterListProps {
  /**
   * 「カテゴリ」見出しと「未分類」見出しの間に差し込む slot（テンプレート列用）。
   *
   * カテゴリー樹（本 component）とは別枠のフラットな一覧を、入れ子にせず
   * 挟み込むためだけの穴。ActivityFilterList 自身はテンプレートの中身を
   * 知らない（`@/features/calendar` barrel 経由で呼び出し側が組み立てる）。
   */
  betweenCategoriesAndUncategorized?: ReactNode | undefined;
}

export function ActivityFilterList({ betweenCategoriesAndUncategorized }: ActivityFilterListProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const { data: tree, isLoading, isFetching } = useActivityTree();
  const { data: stats, isError: isStatsError } = api.statistics.getActivityStats.useQuery();
  const { data: archivedActivities, isFetching: isArchivedFetching } = useArchivedActivities();
  const { data: archivedCategories } = useArchivedCategories();

  // `?? []` を直接書くと毎 render で新しい配列になり、下流の useMemo /
  // useCallback の依存が毎回変わる。空配列を定数に固定して安定させる
  const rawCategories = useMemo(() => tree?.categories ?? EMPTY_CATEGORIES, [tree]);
  const rawUncategorized = tree?.uncategorized ?? EMPTY_ACTIVITIES;

  // 並び替えはカテゴリー配下と未分類の両方へ一様にかける（カテゴリー自体の順序は
  // サーバーの名前順のまま触らない）。`lastUsed` は削除件数のために既に取得済みの
  // getActivityStats に入っているので、この機能のための追加クエリは無い
  const sortKey = useActivitySortStore((s) => s.sortKey);
  const setSortKey = useActivitySortStore((s) => s.setSortKey);
  const lastUsed = useMemo(() => stats?.lastUsed ?? EMPTY_LAST_USED, [stats]);

  const categories = useMemo(
    () =>
      rawCategories.map((node) => ({
        ...node,
        activities: sortActivities(node.activities, sortKey, lastUsed),
      })),
    [rawCategories, sortKey, lastUsed],
  );
  const uncategorized = useMemo(
    () => sortActivities(rawUncategorized, sortKey, lastUsed),
    [rawUncategorized, sortKey, lastUsed],
  );

  const categoryOptions = useMemo<CategoryOption[]>(
    () =>
      categories.map(({ category }) => ({
        id: category.id,
        name: category.name,
        color: category.color,
        icon: category.icon,
      })),
    [categories],
  );

  /** 「カテゴリーを変更」ピッカーと同名衝突の検出に使う全アクティビティ */
  const allActivities = useMemo(() => collectActivitiesFromTree(tree), [tree]);

  // 削除判定・確認ダイアログ用: records + plans の合計件数。
  // エラー時は null にして削除確認ダイアログを常に表示する（誤削除防止）。
  const deleteCounts = useMemo(
    () => mergeActivityDeleteCounts(stats, isStatsError),
    [stats, isStatsError],
  );

  const deleteActivityMutation = useDeleteActivity();
  const deleteCategoryMutation = useDeleteCategory();
  const archiveActivityMutation = useArchiveActivity();
  const archiveCategoryMutation = useArchiveCategory();
  const { openActivityCreateModal } = useActivityModalNavigation();

  const visibleActivityIds = useCalendarFilterStore((s) => s.visibleActivityIds);
  const toggleActivity = useCalendarFilterStore((s) => s.toggleActivity);
  const syncWithActivities = useCalendarFilterStore((s) => s.syncWithActivities);
  const showOnlyActivity = useCalendarFilterStore((s) => s.showOnlyActivity);
  const showOnlyCategoryActivities = useCalendarFilterStore((s) => s.showOnlyCategoryActivities);
  const getCategoryVisibility = useCalendarFilterStore((s) => s.getCategoryVisibility);

  // 一覧と filter state を同期（新規は visible 追加、削除済みは orphan として除去）。
  //
  // アーカイブ済み ID も含める。含めないと、アーカイブ済みアクティビティを参照する
  // 過去ブロックが orphan 扱いで visibleActivityIds から消え、カレンダーから見えなくなる
  // （#1576 の回帰）。
  //
  // **tree と archived は別クエリなので、両方の fetch 完了を待つ。** 片方だけで
  // sync すると欠けている側の ID が orphan として除去され、`knownActivityIds` も
  // その集合で上書きされる。tRPC の httpBatchLink は同一 tick の呼び出しを束ねるため
  // 通常は同時に解決するが、mount tick がずれる経路（ルート遷移・hydrate の分割）では
  // その前提が崩れる。バッチングに依存させない。
  //
  // `useCalendarData` も同じ store を sync するので、**渡す ID 集合を揃える**こと。
  // ズレると後から走った方が相手の ID を orphan として消す。
  const allFilterableIds = useMemo(
    () => [
      ...collectActivityIdsFromTree(tree),
      ...(archivedActivities ?? []).map((activity) => activity.id),
    ],
    [tree, archivedActivities],
  );

  useEffect(() => {
    if (isFetching || isArchivedFetching) return;
    if (allFilterableIds.length === 0) return;
    syncWithActivities(allFilterableIds);
  }, [allFilterableIds, syncWithActivities, isFetching, isArchivedFetching]);

  // 一覧の表示ステータス。すべて / アクティブ（既定）/ アーカイブの排他選択
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('active');
  const showActive = statusFilter !== 'archived';
  const showArchived = statusFilter !== 'active';
  // 表示メニューの開閉。開いている間は未分類見出しの action（+ / 歯車）を隠さない
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);

  // 既定は展開。折りたたんだカテゴリーだけを集合で持つ
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // 未分類見出しの開閉。既定は展開（クリックで押した見出しからそのまま作れる導線を保つ）
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);
  // 「カテゴリ」見出し（個々のカテゴリー群をまとめる親見出し）の開閉。既定は展開
  const [categoriesSectionCollapsed, setCategoriesSectionCollapsed] = useState(false);
  // カテゴリー作成 popover の開閉。開いている間は「カテゴリ」見出しの + を隠さない（#2211）
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false);

  const toggleCategoryCollapse = useCallback((categoryId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'activity' | 'category';
    id: string;
    name: string;
    affectedCount: number;
  } | null>(null);

  // 削除は不可逆なので、影響件数に関わらず必ず確認を挟む（2026-09-04 User 指示）。
  // 件数は「関連する予定・記録がどうなるか」を説明するためだけに使う。
  // stats 未取得 / エラー時は安全側に倒して 1 件以上として扱う
  const handleDeleteActivity = useCallback(
    (id: string, name: string) => {
      const affectedCount = deleteCounts === null ? 1 : (deleteCounts[id] ?? 0);
      setDeleteTarget({ kind: 'activity', id, name, affectedCount });
    },
    [deleteCounts],
  );

  // カテゴリー削除は予定・記録に触れない。影響するのは所属アクティビティが
  // 未分類へ移ることだけなので、件数は tree から数える（stats は使わない）
  const handleDeleteCategory = useCallback(
    (id: string, name: string) => {
      const memberCount =
        categories.find((node) => node.category.id === id)?.activities.length ?? 0;
      setDeleteTarget({ kind: 'category', id, name, affectedCount: memberCount });
    },
    [categories],
  );

  const handleArchiveActivity = useCallback(
    (id: string) => {
      archiveActivityMutation.mutate({ id });
    },
    [archiveActivityMutation],
  );

  const handleArchiveCategory = useCallback(
    (id: string) => {
      archiveCategoryMutation.mutate({ id });
    },
    [archiveCategoryMutation],
  );

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === 'category') {
        await deleteCategoryMutation.mutateAsync({ id: deleteTarget.id });
      } else {
        await deleteActivityMutation.mutateAsync({ id: deleteTarget.id });
      }
    } finally {
      setDeleteTarget(null);
    }
  };

  // 各セクションの空状態（empty state）。見出しは常に出るので、中身が無い時は
  // 見出しだけが宙に浮かないよう一行の文言を置く。カテゴリー・未分類・テンプレート
  // の3セクションとも、中身が無ければ常にその場で言い切る（新規ユーザー向けの
  // 別立てオンボーディング文は持たない。2026-09-03 User 判断）。
  //
  // 未分類の中身は表示ステータスで変わるため、件数も同じ条件で数える。
  const archivedCount = (archivedActivities?.length ?? 0) + (archivedCategories?.length ?? 0);
  const uncategorizedCount =
    (showActive ? uncategorized.length : 0) + (showArchived ? archivedCount : 0);

  return (
    <ActivityDragProvider allActivities={allActivities}>
      <div className="w-full min-w-0 overflow-hidden">
        {isLoading ? (
          <div className="space-y-1 py-1">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            {/* カテゴリー群。個々のカテゴリー見出し（CategoryHeader）とは別に、
                「カテゴリ」全体を示す親見出しを上に置く（未分類見出しと対になる構造）。
                子のカテゴリー見出しと同じく折りたたみを持つ。

                サイドバーの骨格は「カテゴリ」+「未分類」の 2 見出しで固定し、
                件数やステータスで見出しを出し入れしない（2026-08-18 User 指示）。

                **表示ステータス（すべて / アクティブ / アーカイブ）は「未分類」だけに
                かかる。** カテゴリーは独立した単位で、その配下のアクティビティごと
                このフィルタの影響を受けない（2026-08-18 User 指示）。

                次のセクションとの余白は、自分が開いているかどうかで自分の下に
                margin-bottom を足す形で決める（開＝下に24px / 閉＝下に8px）。
                次のセクション側の margin-top で決めると、その次のセクション自身を
                開閉するたびに「自分の上の余白」が動いて見出しごと位置がずれる
                （2026-09-04 User 指摘: テンプレートを開くと不自然に下へ動いた）*/}
            <div className={categoriesSectionCollapsed ? 'mb-2' : 'mb-6'}>
              <SidebarSection
                title={t('calendar.filter.categoriesSection')}
                // カテゴリー「群」の間隔は CategoryGroup 自身が自分の開閉状態で
                // 持つ（開いている時だけ margin-bottom）。ここでは指定しない
                collapsed={categoriesSectionCollapsed}
                onToggleCollapse={() => setCategoriesSectionCollapsed((prev) => !prev)}
                action={
                  // 「未分類」の + と対称: 常時は隠し、見出し行にホバー / フォーカス
                  // した時だけ出す。popover 展開中は categoryCreateOpen で強制表示
                  <span
                    className={cn(
                      'opacity-0 transition-opacity',
                      categoryCreateOpen
                        ? 'opacity-100'
                        : 'group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100',
                    )}
                  >
                    <CategoryCreateDialog onOpenChange={setCategoryCreateOpen} />
                  </span>
                }
              >
                {categories.map(({ category, activities }) => (
                  <CategoryGroup
                    key={category.id}
                    category={category}
                    activities={activities}
                    allActivities={allActivities}
                    visibleActivityIds={visibleActivityIds}
                    categoryOptions={categoryOptions}
                    collapsed={collapsedCategories.has(category.id)}
                    isMobile={isMobile}
                    onToggleCollapse={() => toggleCategoryCollapse(category.id)}
                    onToggleActivity={toggleActivity}
                    onShowOnlyActivity={showOnlyActivity}
                    onShowOnlyCategoryActivities={showOnlyCategoryActivities}
                    getCategoryVisibility={getCategoryVisibility}
                    onArchiveCategory={handleArchiveCategory}
                    onDeleteCategory={handleDeleteCategory}
                    onArchiveActivity={handleArchiveActivity}
                    onDeleteActivity={handleDeleteActivity}
                  />
                ))}

                {categories.length === 0 ? (
                  <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
                    {t('calendar.filter.noCategories')}
                  </p>
                ) : null}
              </SidebarSection>
            </div>

            {betweenCategoriesAndUncategorized}

            {/* 未分類（カテゴリー未所属のアクティビティ） + アクティビティなし行。
                「未分類」は分類の名前ではなく並びの単位なので、アーカイブ単独表示でも
                文言は変えない（2026-08-18 User 指示）。見出し構造自体は状態によらず
                同じにする — 表示メニュー（+ / 歯車）を毎回同じ場所に残すことで、
                アーカイブ単独表示にしてもメニューへ戻る手段を失わない */}
            <SidebarSection
              title={t('calendar.filter.uncategorized')}
              className="space-y-1"
              collapsed={uncategorizedCollapsed}
              onToggleCollapse={() => setUncategorizedCollapsed((prev) => !prev)}
              action={
                // 常時は隠し、見出し行にホバー / フォーカスした時だけ出す。
                // メニュー展開中は displayMenuOpen を直接見て強制表示する
                // （DropdownMenuContent は portal で group の外に出るため、
                // メニュー項目へキーボード移動すると focus-within が切れてしまう）
                <span
                  className={cn(
                    'flex items-center gap-1 transition-opacity',
                    displayMenuOpen
                      ? 'opacity-100'
                      : 'opacity-0 group-hover/section:opacity-100 group-has-[:focus-visible]/section:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100',
                  )}
                >
                  <HoverTooltip content={t('calendar.filter.createActivity')} side="top">
                    <Button
                      variant="ghost"
                      icon
                      className="size-6"
                      aria-label={t('calendar.filter.createActivity')}
                      onClick={() => openActivityCreateModal()}
                    >
                      <Plus className="size-4" />
                    </Button>
                  </HoverTooltip>
                  <DropdownMenu open={displayMenuOpen} onOpenChange={setDisplayMenuOpen}>
                    <HoverTooltip content={t('calendar.filter.activitySettings')} side="top">
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          icon
                          // メニューを開いている間は hover 状態を維持し、どのボタンから
                          // 出ているメニューなのかを保つ。Radix の data-state 属性ではなく
                          // React state で当てる（ActivityRow の menuOpen と同じ手口）
                          className={cn('size-6', displayMenuOpen && 'bg-state-hover')}
                          aria-label={t('calendar.filter.activitySettings')}
                        >
                          <Settings2 className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </HoverTooltip>
                    <DropdownMenuContent align="end">
                      {/* ステータスは未分類だけにかかり、並び替えは全アクティビティに
                          かかる（かかる範囲が違うのは意図的。ステータスはアーカイブの
                          話で、並び替えはアクティビティの話）。#2162 / 2026-09-03 */}
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Archive className="size-4" />
                          {t('calendar.filter.statusSection')}
                          {/* 開かなくても現在値が読めるようにする。ml-auto で右へ寄せると
                              直後の chevron がその隣に並ぶ（SubTrigger の chevron も ml-auto） */}
                          <span className="text-muted-foreground ml-auto text-xs">
                            {t(STATUS_LABEL_KEYS[statusFilter])}
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={statusFilter}
                            onValueChange={(value) =>
                              setStatusFilter(value as 'all' | 'active' | 'archived')
                            }
                          >
                            <DropdownMenuRadioItem value="all">
                              {t('calendar.filter.statusAll')}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="active">
                              {t('calendar.filter.statusActive')}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="archived">
                              {t('calendar.filter.statusArchived')}
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>

                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <ArrowDownUp className="size-4" />
                          {t('calendar.filter.sortSection')}
                          <span className="text-muted-foreground ml-auto text-xs">
                            {t(SORT_LABEL_KEYS[sortKey])}
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={sortKey}
                            onValueChange={(value) => setSortKey(value as ActivitySortKey)}
                          >
                            <DropdownMenuRadioItem value="name">
                              {t('calendar.filter.sortByName')}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="lastUsed">
                              {t('calendar.filter.sortByLastUsed')}
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              }
            >
              <UncategorizedDropZone>
                {showActive ? (
                  <div role="list">
                    {uncategorized.map((activity) => (
                      <ActivityRow
                        key={activity.id}
                        activity={activity}
                        allActivities={allActivities}
                        checked={visibleActivityIds.has(activity.id)}
                        categoryId={null}
                        categoryOptions={categoryOptions}
                        isMobile={isMobile}
                        onToggle={() => toggleActivity(activity.id)}
                        onArchiveActivity={() => handleArchiveActivity(activity.id)}
                        onDeleteActivity={() => handleDeleteActivity(activity.id, activity.name)}
                        onShowOnlyActivity={() => showOnlyActivity(activity.id)}
                      />
                    ))}
                  </div>
                ) : null}

                {/* アーカイブ済みは種別を問わずここへ出す。アーカイブは未分類の話であって
                  カテゴリーの話ではない（2026-08-18 User 指示）。
                  アクティブ / すべて表示中は「未分類」の折りたたみに含まれ、アーカイブ
                  単独表示中はこの見出しの内容そのものになる */}
                {showArchived ? (
                  <ArchivedActivityList
                    onDeleteActivity={handleDeleteActivity}
                    onDeleteCategory={handleDeleteCategory}
                  />
                ) : null}

                {/* 空状態。アーカイブ単独表示で 0 件の時は「アーカイブ済みが無い」と
                  言い切る（未分類そのものが空だと誤読させない） */}
                {uncategorizedCount === 0 ? (
                  <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
                    {statusFilter === 'archived'
                      ? t('calendar.filter.noArchived')
                      : t('calendar.filter.noUncategorized')}
                  </p>
                ) : null}
              </UncategorizedDropZone>
            </SidebarSection>
          </>
        )}
      </div>

      {/* 完全削除の確認ダイアログ（関連 Plan / Record はアクティビティなしになる） */}
      <ActivityDeleteConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        kind={deleteTarget?.kind ?? 'activity'}
        name={deleteTarget?.name ?? ''}
        affectedCount={deleteTarget?.affectedCount ?? 0}
      />
    </ActivityDragProvider>
  );
}
