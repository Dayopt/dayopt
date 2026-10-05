'use client';

import { isCancelledError, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

import { useTimeblockInspectorStore } from '../stores/useTimeblockInspectorStore';
import {
  deleteTimeblockCacheRows,
  insertTimeModelRowIntoMatchingLists,
  isTimeblockCacheCurrent,
  restoreTimeblockLists,
  settleTimeblockCache,
  snapshotTimeblockLists,
  writeTimeblockCache,
} from './useTimeblockWriteMutations';

function isTimeOverlapError(error: { message: string }): boolean {
  const serviceCode =
    'data' in error && error.data && typeof error.data === 'object' && 'serviceCode' in error.data
      ? error.data.serviceCode
      : undefined;
  return serviceCode === 'TIME_OVERLAP' || error.message.includes('TIME_OVERLAP');
}

/** Plan → Record の記録導線に共通の rollback / 再検証を提供する。 */
export function useTimeblockRecordMutations() {
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const t = useTranslations('timeblock.editor');
  const tCommon = useTranslations('common');

  // 「そのまま記録」の取り消し。作成した Record を消すだけで Plan は残る。
  // 作成系（サイドバーのタップ / ドラッグ作成）と同じくトーストから戻せるようにする
  const undoRecord = api.recordCommands.delete.useMutation({
    retry: false,
    onMutate: async (input) => {
      const context = await snapshotTimeblockLists(queryClient);
      deleteTimeblockCacheRows(queryClient, context, 'records', new Set([input.id]));
      return context;
    },
    onError: (_error, _input, context) => {
      restoreTimeblockLists(queryClient, context);
      if (isCancelledError(_error)) return;
      toast.error(t('toast.undoFailed'));
    },
    onSettled: (_data, _error, _input, context) => {
      const current = isTimeblockCacheCurrent(queryClient, context);
      settleTimeblockCache(queryClient, context);
      if (!current) return;
      void utils.records.list.invalidate();
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          Array.isArray(queryKey[0]) && ['statistics', 'review'].includes(queryKey[0][0]),
      });
    },
  });

  const recordPlan = api.planCommands.record.useMutation({
    retry: false,
    onMutate: async () => {
      return snapshotTimeblockLists(queryClient);
    },
    onSuccess: (record, _input, context) => {
      if (!context || !isTimeblockCacheCurrent(queryClient, context)) return;
      writeTimeblockCache(queryClient, context, () => {
        insertTimeModelRowIntoMatchingLists(queryClient, 'records', record);
        utils.records.getById.setData({ id: record.id }, record);
      });
      toast.success(t('toast.recorded'), {
        duration: 5000,
        action: {
          label: tCommon('undo'),
          onClick: () => {
            // 取り消した Record を詳細で開いたままにしない
            if (useTimeblockInspectorStore.getState().timeblockId === record.id) {
              useTimeblockInspectorStore.getState().closeInspector();
            }
            undoRecord.mutate({ id: record.id, expectedUpdatedAt: record.updated_at });
          },
        },
      });
    },
    onError: (error, _input, context) => {
      restoreTimeblockLists(queryClient, context);
      if (isCancelledError(error)) return;
      toast.error(isTimeOverlapError(error) ? t('toast.overlap') : t('toast.recordFailed'));
    },
    onSettled: (_data, _error, _input, context) => {
      const current = isTimeblockCacheCurrent(queryClient, context);
      settleTimeblockCache(queryClient, context);
      if (!current) return;
      void utils.plans.list.invalidate();
      void utils.records.list.invalidate();
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          Array.isArray(queryKey[0]) && ['statistics', 'review'].includes(queryKey[0][0]),
      });
    },
  });

  const confirmDay = api.planCommands.confirmDay.useMutation({
    retry: false,
    onMutate: async () => {
      return snapshotTimeblockLists(queryClient);
    },
    onSuccess: (records, _input, context) => {
      if (!context || !isTimeblockCacheCurrent(queryClient, context)) return;
      writeTimeblockCache(queryClient, context, () => {
        for (const record of records) {
          insertTimeModelRowIntoMatchingLists(queryClient, 'records', record);
          utils.records.getById.setData({ id: record.id }, record);
        }
      });
      toast.success(t('toast.dayConfirmed'));
    },
    onError: (error, _input, context) => {
      restoreTimeblockLists(queryClient, context);
      if (isCancelledError(error)) return;
      toast.error(isTimeOverlapError(error) ? t('toast.overlap') : t('toast.confirmFailed'));
    },
    onSettled: (_data, _error, _input, context) => {
      const current = isTimeblockCacheCurrent(queryClient, context);
      settleTimeblockCache(queryClient, context);
      if (!current) return;
      void utils.plans.list.invalidate();
      void utils.records.list.invalidate();
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          Array.isArray(queryKey[0]) && ['statistics', 'review'].includes(queryKey[0][0]),
      });
    },
  });

  return { confirmDay, recordPlan };
}
