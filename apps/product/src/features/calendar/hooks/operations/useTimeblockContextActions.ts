'use client';

import { useCallback } from 'react';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

import { useTimeblockWriteMutations } from '@/features/timeblock';

import { buildReportPath } from '../../lib/panel-url';
import type { CalendarDisplayEvent } from '../../types/calendar.types';

/** コンテキストメニューで使用する plan / record 操作アクションを提供するフック */
export function useTimeblockContextActions() {
  const router = useRouter();
  const locale = useLocale();
  const { deleteRecord, deletePlan } = useTimeblockWriteMutations();

  const handleDeleteTimeblock = useCallback(
    (entry: CalendarDisplayEvent) => {
      if (entry.recordSource === 'auto_migrated') return;
      if ((entry.kind ?? 'plan') === 'plan') {
        deletePlan.mutate({ id: entry.id, expectedUpdatedAt: entry.version });
      } else {
        deleteRecord.mutate({ id: entry.id, expectedUpdatedAt: entry.version });
      }
    },
    [deletePlan, deleteRecord],
  );

  const handleViewStats = useCallback(
    (entry: CalendarDisplayEvent) => {
      if (!entry.activityId) return;
      // カレンダー内パネル（CalendarReviewRail）は廃止済み（#2181 Step 4）。
      // アクティビティによるセグメント絞り込みは Step 5（セグメント配線）で復元する。
      router.push(buildReportPath(locale, entry.startDate ?? entry.actualStartDate ?? new Date()));
    },
    [router, locale],
  );

  return {
    handleDeleteTimeblock,
    handleViewStats,
  };
}
