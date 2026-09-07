'use client';

/**
 * サイドバー / チップ行のアクティビティタップからブロックを即作成する。
 *
 * タップした瞬間に既定の長さで作り、作成したブロックを編集と同じ右パネル
 * （モバイルは Drawer）で開く。時間・メモの修正はそのパネルで行うため、作成前に
 * 埋めるフォームは持たない。取り消しは 5 秒のトーストから行う。
 *
 * 保存先は end_at のルールで決まる（過去 → 記録、未来 → 予定）。既定の開始時刻は
 * 今日なら現在時刻、それ以外は 09:00 なので、今日のタップは常に「今から先」＝予定になる。
 *
 * 既定の枠が同じレーンの既存ブロックと重なる時は作成しない。作らずに知らせる方が、
 * サーバーの EXCLUDE 制約で弾かれてから戻すより短い（重なる時はカレンダー上で
 * ドラッグして空いている場所を指せばよい）。
 */

import { useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { isSameDay, startOfDay } from 'date-fns';
import { useTranslations } from 'next-intl';

import {
  collectTimeblockLaneItems,
  hasTimeblockLaneConflict,
  resolveTimeblockDestination,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { toast } from '@/lib/toast';

/** 開始時刻の既定: 対象日が今日なら現在時刻を次の 1 分境界へ ceil、それ以外は 09:00 */
function defaultStartAt(forDate: Date): Date {
  const now = new Date();
  if (isSameDay(forDate, now)) {
    const ONE_MIN_MS = 60 * 1000;
    return new Date(Math.ceil(now.getTime() / ONE_MIN_MS) * ONE_MIN_MS);
  }
  const start = startOfDay(forDate);
  start.setHours(9, 0, 0, 0);
  return start;
}

interface QuickCreateArgs {
  activityId: string;
  activityName: string;
  /** 作成先の日付。省略時は今日 */
  date?: Date | undefined;
}

/** アクティビティのタップから既定の長さでブロックを作り、詳細パネルを開く */
export function useActivityQuickCreate() {
  const t = useTranslations();
  const timezone = useUserPreferences((s) => s.timezone);
  const defaultDuration = useUserPreferences((s) => s.defaultDuration);
  const queryClient = useQueryClient();
  const { createPlan, createRecord, deletePlan, deleteRecord } = useTimeblockWriteMutations();
  const openInspector = useTimeblockInspectorStore((state) => state.openInspector);
  const closeInspector = useTimeblockInspectorStore((state) => state.closeInspector);

  return useCallback(
    ({ activityId, activityName, date }: QuickCreateArgs) => {
      const localStart = defaultStartAt(date ?? new Date());
      const localEnd = new Date(localStart.getTime() + defaultDuration * 60 * 1000);
      const startAt = convertFromTimezone(localStart, timezone);
      const endAt = convertFromTimezone(localEnd, timezone);
      const destination = resolveTimeblockDestination(endAt);

      // 同一レーンのみ禁止（plan×plan / record×record）。plan×record は共存できる
      const laneItems = collectTimeblockLaneItems(
        queryClient,
        destination === 'plan' ? 'plans' : 'records',
      );
      if (hasTimeblockLaneConflict(laneItems, startAt, endAt)) {
        toast.error(t('timeblock.errors.timeOverlap'));
        return;
      }

      const mutation = destination === 'plan' ? createPlan : createRecord;
      mutation.mutate(
        {
          title: activityName,
          activityId,
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
        },
        {
          onSuccess: (created) => {
            if (!created?.id) return;
            // 作ったブロックをそのまま詳細で開く。時間の修正はこのパネルか
            // カレンダー上のドラッグで行う
            openInspector(created.id, destination);
            toast.success(t('timeblock.toast.created', { title: activityName }), {
              duration: 5000,
              action: {
                label: t('common.undo'),
                onClick: () => {
                  // 取り消したブロックを詳細で開いたままにしない
                  if (useTimeblockInspectorStore.getState().timeblockId === created.id) {
                    closeInspector();
                  }
                  const payload = { id: created.id, expectedUpdatedAt: created.updated_at };
                  if (destination === 'plan') {
                    deletePlan.mutate(payload);
                  } else {
                    deleteRecord.mutate(payload);
                  }
                },
              },
            });
          },
        },
      );
    },
    [
      closeInspector,
      createPlan,
      createRecord,
      defaultDuration,
      deletePlan,
      deleteRecord,
      openInspector,
      queryClient,
      t,
      timezone,
    ],
  );
}
