'use client';

import { useCallback } from 'react';

import { useActivitiesMap } from '@/features/activities';
import {
  useTimeblockDeleteUndo,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';

import type { CalendarDisplayEvent } from '../../types/calendar.types';

/** コンテキストメニューで使用する plan / record 操作アクションを提供するフック */
export function useTimeblockContextActions() {
  const { deleteRecord, deletePlan } = useTimeblockWriteMutations();
  const showDeleteUndo = useTimeblockDeleteUndo();
  const { getActivityById } = useActivitiesMap();

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

  const handleViewActivityDetails = useCallback(
    (timeblock: CalendarDisplayEvent) => {
      if (!timeblock.activityId) return;
      const activity = getActivityById(timeblock.activityId);
      useActivityDetailStore.getState().open({
        activityId: timeblock.activityId,
        name: activity?.name ?? timeblock.title,
        categoryName: activity?.categoryName ?? null,
        color: activity?.color ?? null,
      });
      useTimeblockInspectorStore.getState().closeInspector();
    },
    [getActivityById],
  );

  return {
    handleDeleteTimeblock,
    handleViewActivityDetails,
  };
}
