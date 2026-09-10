import { useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import {
  resolveTimeblockDestination,
  useTimeblockDeleteUndo,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { logger } from '@/lib/logger';
import { toast } from '@/lib/toast';

import type { TimeblockDestination } from '@/features/timeblock';
import type { CalendarDisplayEvent } from '../../types/calendar.types';

interface TimeModelCacheRow {
  id: string;
  start_at: string;
  end_at: string;
  updated_at: string;
  source: string;
}

function isLaneListQuery(lane: 'plans' | 'records') {
  return (query: { queryKey: unknown }): boolean => {
    const key = query.queryKey;
    return (
      Array.isArray(key) && Array.isArray(key[0]) && key[0][0] === lane && key[0][1] === 'list'
    );
  };
}

function findRowInLane(
  queryClient: ReturnType<typeof useQueryClient>,
  lane: 'plans' | 'records',
  id: string,
): TimeModelCacheRow | null {
  const lists = queryClient.getQueriesData<TimeModelCacheRow[]>({
    predicate: isLaneListQuery(lane),
  });
  for (const [, data] of lists) {
    const row = data?.find((candidate) => candidate.id === id);
    if (row) return row;
  }
  return null;
}

/** plans.list / records.list キャッシュから id で 1 行探す。見つかった方が kind を決める。 */
function findTimeModelRowById(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
): { kind: TimeblockDestination; row: TimeModelCacheRow } | null {
  const planRow = findRowInLane(queryClient, 'plans', id);
  if (planRow) return { kind: 'plan', row: planRow };
  const recordRow = findRowInLane(queryClient, 'records', id);
  if (recordRow) return { kind: 'record', row: recordRow };
  return null;
}

/**
 * Plan / Record の CRUD（削除・時間更新）を提供するフック。
 *
 * カレンダーの DnD / リサイズ / キーボード削除は id だけを渡してくる（kind を持たない）ため、
 * plans.list / records.list キャッシュから id を逆引きして kind を判定する。
 */
export const useTimeblockOperations = () => {
  const { deleteRecord, deletePlan, updateRecord, updatePlan } = useTimeblockWriteMutations();
  // 削除の戻し方はカレンダーと Inspector で 1 つに揃える
  const showDeleteUndo = useTimeblockDeleteUndo();
  const queryClient = useQueryClient();
  const t = useTranslations();

  const showTimeChangeUndoToast = useCallback(
    (
      id: string,
      kind: TimeblockDestination,
      previous: { start_at: string; end_at: string },
      expectedUpdatedAt: string,
    ) => {
      toast.success(t('timeblock.toast.updated'), {
        duration: 6000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            const data = { start_at: previous.start_at, end_at: previous.end_at };
            if (kind === 'plan') {
              updatePlan.mutate({ id, data, expectedUpdatedAt });
            } else {
              updateRecord.mutate({ id, data, expectedUpdatedAt });
            }
          },
        },
      });
    },
    [updatePlan, updateRecord, t],
  );

  // Timeblock 削除ハンドラー（id のみ。kind はキャッシュから逆引きする）
  const handleTimeblockDelete = useCallback(
    async (timeblockId: string): Promise<boolean> => {
      const found = findTimeModelRowById(queryClient, timeblockId);
      if (!found) {
        logger.error('Timeblock の削除に失敗: id がキャッシュに見つかりません', {
          timeblockId,
        });
        return false;
      }
      if (found.row.source === 'auto_migrated') return false;
      try {
        const deleted =
          found.kind === 'plan'
            ? await deletePlan.mutateAsync({
                id: timeblockId,
                expectedUpdatedAt: found.row.updated_at,
              })
            : await deleteRecord.mutateAsync({
                id: timeblockId,
                expectedUpdatedAt: found.row.updated_at,
              });
        showDeleteUndo(found.kind, deleted);
        return true;
      } catch {
        return false;
      }
    },
    [queryClient, deletePlan, deleteRecord, showDeleteUndo],
  );

  // Timeblock更新ハンドラー（ドラッグ&ドロップ / リサイズ用）
  const handleUpdateTimeblock = useCallback(
    async (
      timeblockIdOrTimeblock: string | CalendarDisplayEvent,
      updates?: {
        startTime: Date;
        endTime: Date;
        resetActualTime?: boolean;
        expectedUpdatedAt?: string;
      },
    ) => {
      const timeblockId =
        typeof timeblockIdOrTimeblock === 'string'
          ? timeblockIdOrTimeblock
          : timeblockIdOrTimeblock.id;
      const nextRange =
        typeof timeblockIdOrTimeblock === 'string'
          ? updates
            ? { start: updates.startTime, end: updates.endTime }
            : null
          : timeblockIdOrTimeblock.startDate && timeblockIdOrTimeblock.endDate
            ? { start: timeblockIdOrTimeblock.startDate, end: timeblockIdOrTimeblock.endDate }
            : null;

      if (!nextRange) {
        logger.error('startTime/endTimeが無いため更新できません:', timeblockId);
        return;
      }

      // kind が既知（CalendarDisplayEvent object 経由）ならそのレーンだけ、未知なら両レーンを探す。
      // previous 値は常にキャッシュ由来（渡された event 自身は更新後プレビューの可能性があるため）。
      const knownKind =
        typeof timeblockIdOrTimeblock !== 'string' ? timeblockIdOrTimeblock.kind : undefined;
      const projectedVersion =
        typeof timeblockIdOrTimeblock !== 'string' ? timeblockIdOrTimeblock.version : undefined;
      const projectedSource =
        typeof timeblockIdOrTimeblock !== 'string'
          ? timeblockIdOrTimeblock.recordSource
          : undefined;
      const interactionVersion = updates?.expectedUpdatedAt;
      const found = knownKind
        ? {
            kind: knownKind,
            row: findRowInLane(
              queryClient,
              knownKind === 'plan' ? 'plans' : 'records',
              timeblockId,
            ),
          }
        : findTimeModelRowById(queryClient, timeblockId);

      if (!found) {
        logger.error('Timeblock更新に失敗: id がキャッシュに見つかりません', { timeblockId });
        return;
      }
      const expectedUpdatedAt = interactionVersion ?? projectedVersion ?? found.row?.updated_at;
      if (!expectedUpdatedAt) {
        logger.error('Timeblock更新に失敗: version が見つかりません', { timeblockId });
        return;
      }
      if ((found.row?.source ?? projectedSource) === 'auto_migrated') return;

      // record は未来へ移動できない（記録は過去のみ）
      if (found.kind === 'record' && resolveTimeblockDestination(nextRange.end) === 'plan') {
        toast.error(t('timeblock.editor.timeLocked'));
        return;
      }

      const previous = found.row
        ? { start_at: found.row.start_at, end_at: found.row.end_at }
        : null;
      const data = { start_at: nextRange.start.toISOString(), end_at: nextRange.end.toISOString() };
      const onSuccess = (updated: { updated_at: string }) => {
        if (previous) {
          showTimeChangeUndoToast(timeblockId, found.kind, previous, updated.updated_at);
        }
      };

      if (found.kind === 'plan') {
        updatePlan.mutate({ id: timeblockId, data, expectedUpdatedAt }, { onSuccess });
      } else {
        updateRecord.mutate({ id: timeblockId, data, expectedUpdatedAt }, { onSuccess });
      }
    },
    [queryClient, updatePlan, updateRecord, showTimeChangeUndoToast, t],
  );

  return {
    handleTimeblockDelete,
    handleUpdateTimeblock,
  };
};
