'use client';

/**
 * カレンダー用サイドバーの中身。
 *
 * 表示順は「カテゴリ → テンプレート → 未分類」（2026-09-03 User 指示）。
 * テンプレートはカテゴリー樹とは別枠のフラットな一覧で、カテゴリーへの
 * 入れ子はしない（#2411 §5.1）。順序だけを ActivityFilterList の
 * `betweenCategoriesAndUncategorized` slot で差し込む。
 *
 * テンプレートの作成導線はここに置かない。作成は常に
 * 「生きた日」からのみ行う仕様で、入口は日ビューのヘッダーメニューにある
 * （#2411 §5.4 の空フォルダ病の予防。仕様であってバグではない）。
 *
 * クリックで適用する先は「カレンダーが今表示している日」。`viewedDate` は
 * 壁時計 Date なので、暦日は timezone 無しで読む（#2017 の同型バグを避ける）。
 */

import { useCallback, useMemo } from 'react';

import { useActivitiesMap } from '@/features/activities';
import {
  ActivityFilterList,
  TemplateList,
  toTemplateView,
  useCalendarNavigationStore,
  ViewSwitcherList,
} from '@/features/calendar';
import { usePlanTemplateMutations } from '@/features/timeblock';
import { getDateKey } from '@/lib/date';
import { api } from '@/lib/trpc';

export function CalendarSidebar() {
  const { data, isPending, isError, refetch } = api.planTemplates.list.useQuery();
  const { getActivityById } = useActivitiesMap();
  const viewedDate = useCalendarNavigationStore((state) => state.viewedDate);
  const { applyToDay, renameTemplate, deleteTemplate } = usePlanTemplateMutations();

  const templates = useMemo(
    () => (data ?? []).map((template) => toTemplateView(template, getActivityById)),
    [data, getActivityById],
  );

  const handleApply = useCallback(
    (templateId: string) => {
      // 連打を止める。2 通目は必ず重複で失敗し、その rollback が 1 通目の確定行を
      // 巻き戻してしまう（onSettled の再取得まで画面に偽の行が残る）
      if (applyToDay.isPending) return;
      applyToDay.mutate({ templateId, date: getDateKey(viewedDate) });
    },
    [applyToDay, viewedDate],
  );

  const handleRename = useCallback(
    (templateId: string, name: string) => {
      renameTemplate.mutate({ templateId, name });
    },
    [renameTemplate],
  );

  const handleDelete = useCallback(
    (templateId: string) => {
      deleteTemplate.mutate({ templateId });
    },
    [deleteTemplate],
  );

  return (
    <div className="flex min-w-0 flex-col gap-2 overflow-hidden px-2">
      <ViewSwitcherList />
      <ActivityFilterList
        betweenCategoriesAndUncategorized={
          <TemplateList
            templates={templates}
            isLoading={isPending}
            isError={isError}
            onRetry={() => void refetch()}
            onApplyTemplate={handleApply}
            onRenameTemplate={handleRename}
            onDeleteTemplate={handleDelete}
          />
        }
      />
    </div>
  );
}
