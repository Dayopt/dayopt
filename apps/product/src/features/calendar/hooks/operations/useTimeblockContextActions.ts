'use client';

import { useCallback } from 'react';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

import { useTimeblockDeleteUndo, useTimeblockWriteMutations } from '@/features/timeblock';

import { buildReportPath } from '../../lib/panel-url';
import type { CalendarDisplayEvent } from '../../types/calendar.types';

/** コンテキストメニューで使用する plan / record 操作アクションを提供するフック */
export function useTimeblockContextActions() {
  const router = useRouter();
  const locale = useLocale();
  const { deleteRecord, deletePlan } = useTimeblockWriteMutations();
  const showDeleteUndo = useTimeblockDeleteUndo();

  const handleDeleteTimeblock = useCallback(
    (timeblock: CalendarDisplayEvent) => {
      if (timeblock.recordSource === 'auto_migrated') return;
      const kind = timeblock.kind ?? 'plan';
      const input = { id: timeblock.id, expectedUpdatedAt: timeblock.version };
      // 右クリックからの削除も、キーボードや Inspector と同じ戻し方にする
      const onSuccess = (deleted: { id: string; updated_at: string }) =>
        showDeleteUndo(kind, deleted);
      if (kind === 'plan') {
        deletePlan.mutate(input, { onSuccess });
      } else {
        deleteRecord.mutate(input, { onSuccess });
      }
    },
    [deletePlan, deleteRecord, showDeleteUndo],
  );

  const handleViewStats = useCallback(
    (timeblock: CalendarDisplayEvent) => {
      if (!timeblock.activityId) return;
      // カレンダー内パネル（CalendarReviewRail）は廃止済み（#2181 Step 4）。
      // アクティビティによるセグメント絞り込みは Step 5（セグメント配線）で復元する。
      router.push(buildReportPath(locale, timeblock.startDate ?? new Date()));
    },
    [router, locale],
  );

  return {
    handleDeleteTimeblock,
    handleViewStats,
  };
}
