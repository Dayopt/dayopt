'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

import type { PublicRecordRow } from '@/lib/database';

import { useTimeblockInspectorStore } from '../stores/useTimeblockInspectorStore';
import { insertTimeModelRowIntoMatchingLists } from './useTimeblockWriteMutations';

function isRecordsListQuery(query: { queryKey: unknown }): boolean {
  const key = query.queryKey;
  return (
    Array.isArray(key) && Array.isArray(key[0]) && key[0][0] === 'records' && key[0][1] === 'list'
  );
}

function isTimeModelListQuery(query: { queryKey: unknown }): boolean {
  const key = query.queryKey;
  return (
    Array.isArray(key) &&
    Array.isArray(key[0]) &&
    (key[0][0] === 'plans' || key[0][0] === 'records') &&
    key[0][1] === 'list'
  );
}

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
      await utils.records.list.cancel();
      const snapshots = queryClient.getQueriesData({ predicate: isRecordsListQuery });
      queryClient.setQueriesData<PublicRecordRow[]>({ predicate: isRecordsListQuery }, (old) =>
        old?.filter((row) => row.id !== input.id),
      );
      return { snapshots };
    },
    onError: (_error, _input, context) => {
      for (const [queryKey, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
      toast.error(t('toast.undoFailed'));
    },
    onSettled: () => {
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
      await Promise.all([utils.plans.list.cancel(), utils.records.list.cancel()]);
      return { snapshots: queryClient.getQueriesData({ predicate: isTimeModelListQuery }) };
    },
    onSuccess: (record) => {
      insertTimeModelRowIntoMatchingLists(queryClient, 'records', record);
      utils.records.getById.setData({ id: record.id }, record);
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
      for (const [queryKey, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
      toast.error(isTimeOverlapError(error) ? t('toast.overlap') : t('toast.recordFailed'));
    },
    onSettled: () => {
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
      await Promise.all([utils.plans.list.cancel(), utils.records.list.cancel()]);
      return { snapshots: queryClient.getQueriesData({ predicate: isTimeModelListQuery }) };
    },
    onSuccess: (records) => {
      for (const record of records) {
        insertTimeModelRowIntoMatchingLists(queryClient, 'records', record);
        utils.records.getById.setData({ id: record.id }, record);
      }
      toast.success(t('toast.dayConfirmed'));
    },
    onError: (error, _input, context) => {
      for (const [queryKey, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
      toast.error(isTimeOverlapError(error) ? t('toast.overlap') : t('toast.confirmFailed'));
    },
    onSettled: () => {
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
