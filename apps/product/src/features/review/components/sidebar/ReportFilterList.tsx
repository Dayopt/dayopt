'use client';

import { useState } from 'react';

import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SidebarIconButton, SidebarSection } from '@/components/shell/sidebar';
import type { Activity } from '@/features/activities';
import { ActivityIcon, useActivityTree } from '@/features/activities';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { cn, Skeleton } from '@dayopt/components';

import { useReportViewStore } from '../../stores/useReportViewStore';

/** カテゴリーの表示状態。カレンダーの `getCategoryVisibility` と同じ 3 値。 */
type GroupVisibility = 'all' | 'some' | 'none';

/**
 * サイドバーの分析フィルタ（仕様 §2）。分母から出し入れするだけの一覧。
 *
 * **骨格・余白・ホバーはカレンダーのサイドバー（`ActivityFilterList`）が正本**
 * （2026-09-15 User 指示）。`features/calendar` は同層で import できないので、
 * `CategoryGroup` / `CategoryHeader` / `ActivityRow` の construction をここへ写す:
 *
 * - 「カテゴリ」「未分類」の 2 見出し（`SidebarSection`、どちらも折りたためる）
 * - カテゴリー見出し行: アイコン `ml-2` → 名前 `ml-2` → 開閉 chevron `ml-1` → 右端の操作 `mr-1`。
 *   行クリックで開閉。展開中の chevron は行ホバーまで隠す
 * - アクティビティ行: テキストだけ（アイコンを出さない）。右端の 👁 は表示中なら行ホバーまで隠し、
 *   外している間は常時出す（戻す手段を隠さない）
 * - 行の高さはマウス面 `h-8` / タッチ面 `h-11`
 *
 * カレンダーと違うのは右端の操作だけ。作成・編集・並び替え・アーカイブの ⋯ メニューは持たず
 * （レポート面では作成も編集もしない、仕様 §0）、カテゴリー見出しにも 👁 を置いて
 * カテゴリーごと出し入れする。行クリックはカレンダーの「即作成」の代わりに表示の切替。
 *
 * **アクティビティ未設定の記録はフィルタ行を持たず、常に数える**（カレンダーと同じ）。
 */
export function ReportFilterList() {
  const t = useTranslations('report.sidebar');
  // `useIsMobile()` は使えない。幅 < 768px では `mobile-layout` が Sidebar ごと
  // 描かないので、この component が生きている間 true になることが無い（分岐が死ぬ）。
  // 実際にタッチで触られるのは iPad 縦のような「幅は広いが coarse pointer」の面
  const isTouch = useMediaQuery(MEDIA_QUERIES.touch);
  const { data: tree, isPending } = useActivityTree();

  const hiddenCategoryIds = useReportViewStore((state) => state.hiddenCategoryIds);
  const hiddenActivityIds = useReportViewStore((state) => state.hiddenActivityIds);
  const toggleCategory = useReportViewStore((state) => state.toggleCategory);
  const toggleActivity = useReportViewStore((state) => state.toggleActivity);

  // 既定は展開。折りたたんだカテゴリーだけを集合で持つ（端末に保存しない。カレンダーと同じ）
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [categoriesSectionCollapsed, setCategoriesSectionCollapsed] = useState(false);
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);

  const toggleCategoryCollapse = (categoryId: string) =>
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  const categories = tree?.categories ?? [];
  const uncategorized = tree?.uncategorized ?? [];

  const visibilityOf = (categoryId: string, memberIds: readonly string[]): GroupVisibility => {
    if (hiddenCategoryIds.includes(categoryId)) return 'none';
    return memberIds.some((id) => hiddenActivityIds.includes(id)) ? 'some' : 'all';
  };

  /**
   * カテゴリー見出しの 👁。
   *
   * - all → カテゴリーを隠す（配下の個別 hidden は触らない。戻した時に解く）
   * - some → 配下の個別 hidden を解いて全部見せる
   * - none → カテゴリーを戻し、配下の個別 hidden も解く
   */
  const handleCategoryToggle = (
    categoryId: string,
    visibility: GroupVisibility,
    memberIds: readonly string[],
  ) => {
    if (visibility === 'some') {
      for (const id of memberIds) if (hiddenActivityIds.includes(id)) toggleActivity(id);
      return;
    }
    toggleCategory(categoryId, visibility === 'none' ? memberIds : undefined);
  };

  /**
   * カテゴリー配下の行の 👁。カテゴリーが隠れている間に押す意図は「この 1 行だけ見る」なので、
   * カテゴリーを戻したうえで兄弟を個別に隠す（カテゴリーだけ戻すと兄弟までまとめて出てしまう）。
   */
  const handleMemberToggle = (
    categoryId: string,
    activityId: string,
    memberIds: readonly string[],
  ) => {
    if (!hiddenCategoryIds.includes(categoryId)) {
      toggleActivity(activityId);
      return;
    }
    toggleCategory(categoryId);
    for (const id of memberIds) {
      const shouldHide = id !== activityId;
      if (shouldHide !== hiddenActivityIds.includes(id)) toggleActivity(id);
    }
  };

  if (isPending) {
    return (
      <div className="w-full min-w-0 overflow-hidden">
        <div className="space-y-1 py-1">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 overflow-hidden">
      {/* 次のセクションとの余白は、自分が開いているかどうかで自分の下に足す
          （開＝24px / 閉＝8px）。カレンダーの「カテゴリ」見出しと同値 */}
      <div className={categoriesSectionCollapsed ? 'mb-2' : 'mb-6'}>
        <SidebarSection
          title={t('categoriesHeading')}
          collapsed={categoriesSectionCollapsed}
          onToggleCollapse={() => setCategoriesSectionCollapsed((prev) => !prev)}
        >
          {categories.map(({ category, activities }) => {
            const memberIds = activities.map((activity) => activity.id);
            const visibility = visibilityOf(category.id, memberIds);
            const collapsed = collapsedCategories.has(category.id);

            return (
              // カテゴリー間の余白は自分の開閉状態で決める（開いている時だけ 8px、最後は 0）
              <div
                key={category.id}
                className={cn('w-full min-w-0 rounded-lg', !collapsed && 'mb-2', 'last:mb-0')}
              >
                <CategoryRow
                  label={category.name}
                  icon={category.icon}
                  color={category.color}
                  visibility={visibility}
                  collapsed={collapsed}
                  isTouch={isTouch}
                  onToggleCollapse={() => toggleCategoryCollapse(category.id)}
                  onToggleVisibility={() =>
                    handleCategoryToggle(category.id, visibility, memberIds)
                  }
                />

                {/* ml-6: 見出しのアイコン + テキストぶんの字下げに子行のテキストを揃える */}
                {!collapsed ? (
                  <div role="list" className="mt-1 ml-6">
                    {activities.map((activity) => (
                      <ActivityFilterRow
                        key={activity.id}
                        activity={activity}
                        visible={visibility !== 'none' && !hiddenActivityIds.includes(activity.id)}
                        isTouch={isTouch}
                        onToggle={() => handleMemberToggle(category.id, activity.id, memberIds)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          {categories.length === 0 ? (
            <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
              {t('empty')}
            </p>
          ) : null}
        </SidebarSection>
      </div>

      {/* 未分類（カテゴリー未所属のアクティビティ）。カレンダーと同じく見出しの下に行を平らに並べ、
          見出し自体には出し入れの口を持たせない */}
      <div className={uncategorizedCollapsed ? 'mb-2' : 'mb-6'}>
        <SidebarSection
          title={t('uncategorized')}
          className="space-y-1"
          collapsed={uncategorizedCollapsed}
          onToggleCollapse={() => setUncategorizedCollapsed((prev) => !prev)}
        >
          {uncategorized.length > 0 ? (
            <div role="list">
              {uncategorized.map((activity) => (
                <ActivityFilterRow
                  key={activity.id}
                  activity={activity}
                  visible={!hiddenActivityIds.includes(activity.id)}
                  isTouch={isTouch}
                  onToggle={() => toggleActivity(activity.id)}
                />
              ))}
            </div>
          ) : (
            <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
              {t('noUncategorized')}
            </p>
          )}
        </SidebarSection>
      </div>
    </div>
  );
}

interface CategoryRowProps {
  label: string;
  icon: string | null;
  color: string | null;
  visibility: GroupVisibility;
  collapsed: boolean;
  isTouch: boolean;
  onToggleCollapse: () => void;
  onToggleVisibility: () => void;
}

/** カテゴリー見出し行。construction はカレンダーの `CategoryHeader` と同じ。 */
function CategoryRow({
  label,
  icon,
  color,
  visibility,
  collapsed,
  isTouch,
  onToggleCollapse,
  onToggleVisibility,
}: CategoryRowProps) {
  const t = useTranslations('report.sidebar');

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- キーボード経路は内側の chevron button（aria-expanded 付き）が持つ。この onClick は見出し行のどこを押しても畳めるようにするマウス用の拡張（カレンダーの CategoryHeader と同じ）
    <div
      data-report-filter-row="category"
      className={cn(
        'group/item hover:bg-state-hover flex w-full min-w-0 cursor-pointer items-center rounded-lg text-sm',
        isTouch ? 'h-11' : 'h-8',
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        onToggleCollapse();
      }}
    >
      <span className="ml-2 shrink-0">
        <ActivityIcon icon={icon} color={color} size="sm" />
      </span>
      <span
        className={cn(
          'ml-2 min-w-0 truncate',
          visibility === 'none' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {label}
      </span>

      <SidebarIconButton
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapse();
        }}
        aria-label={t(collapsed ? 'expandCategory' : 'collapseCategory', { name: label })}
        aria-expanded={!collapsed}
        // icon 自身の hover は持たない。ホバー表現は行全体が担う
        className="hover:text-muted-foreground ml-1 hover:bg-transparent"
        // 展開中は行にカーソルが乗るまで隠す。畳んでいる間は常時表示（開き直す手段を隠さない）
        {...(collapsed ? {} : { revealOn: 'item' as const })}
      >
        <ChevronRight className={cn('size-4 transition-transform', !collapsed && 'rotate-90')} />
      </SidebarIconButton>

      <div className="flex-1" />

      <VisibilityButton
        visible={visibility !== 'none'}
        // 一部だけ外している間も常時出す（全部には戻っていないことを隠さない）
        alwaysShown={visibility !== 'all' || isTouch}
        label={t(visibility === 'all' ? 'hide' : 'show', { name: label })}
        onToggle={onToggleVisibility}
      />
    </div>
  );
}

interface ActivityFilterRowProps {
  activity: Pick<Activity, 'id' | 'name'>;
  visible: boolean;
  isTouch: boolean;
  onToggle: () => void;
}

/**
 * アクティビティ行。construction はカレンダーの `ActivityRow` と同じ（テキストだけ・右端に 👁）。
 * 行クリックは表示の切替（レポート面は作成しないので、カレンダーの「即作成」の代わり）。
 */
function ActivityFilterRow({ activity, visible, isTouch, onToggle }: ActivityFilterRowProps) {
  const t = useTranslations('report.sidebar');

  return (
    <div role="listitem">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- キーボード経路は内側の名前 button と 👁 が持つ。この onClick は行の余白までクリックできるようにするマウス用の拡張（カレンダーの ActivityRow と同じ） */}
      <div
        data-report-filter-row="activity"
        className={cn(
          'group/item hover:bg-state-hover relative flex cursor-pointer items-center rounded-lg text-sm select-none',
          isTouch ? 'h-11' : 'h-8',
        )}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          onToggle();
        }}
      >
        <button
          type="button"
          aria-pressed={visible}
          onClick={onToggle}
          className={cn(
            'focus-visible:ring-ring ml-2 block min-w-0 flex-1 truncate rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none',
            !visible && 'text-muted-foreground',
          )}
        >
          {activity.name}
        </button>

        <VisibilityButton
          visible={visible}
          alwaysShown={!visible || isTouch}
          label={t(visible ? 'hide' : 'show', { name: activity.name })}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

/** 右端の 👁。カレンダーの `ActivityRow` の表示トグルと同じ寸法・出し方（末尾 `mr-1`）。 */
function VisibilityButton({
  visible,
  alwaysShown,
  label,
  onToggle,
}: {
  visible: boolean;
  alwaysShown: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <SidebarIconButton
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-label={label}
      aria-pressed={visible}
      className="mr-1"
      {...(alwaysShown ? {} : { revealOn: 'item' as const })}
    >
      {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </SidebarIconButton>
  );
}
