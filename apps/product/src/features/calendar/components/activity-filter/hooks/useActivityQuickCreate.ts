'use client';

/**
 * サイドバー / チップ行のアクティビティタップからブロックを即作成する。
 *
 * タップした瞬間に作り、作成したブロックを編集と同じ右パネル
 * （モバイルは Drawer）で開く。時間・メモの修正はそのパネルで行うため、作成前に
 * 埋めるフォームは持たない。取り消しは 5 秒のトーストから行う。
 *
 * 長さはそのアクティビティの記録の中央値（`useActivityMedianDurations`）を使い、
 * 中央値が無い（記録 3 件未満）なら設定の既定の長さへフォールバックする。
 * 「いつもこのくらい」で作れる方が、作った後に毎回引き伸ばすより一手少ない。
 *
 * 保存先は end_at のルールで決まる（過去 → 記録、未来 → 予定）。既定の開始時刻は
 * 今日なら現在時刻、それ以外は 09:00 なので、今日のタップは常に「今から先」＝予定になる。
 *
 * 既定の枠が同じレーンの既存ブロックと重なる時は、その日のうちで長さが丸ごと入る
 * 最初の空きへずらす。「今は予定が入っている」は作れない理由にならない（作りたいのは
 * たいてい今の予定の後だから）。長さは縮めず、中央値どおりで置ける場所を探す。
 * その日にもう入らない時だけ、作らずに知らせる。
 */

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useShellStore } from '@/lib/stores/useShellStore';
import { useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { endOfDay, isSameDay, startOfDay } from 'date-fns';
import { useTranslations } from 'next-intl';

import {
  collectTimeblockLaneItems,
  findFreeTimeblockLaneSlot,
  hasTimeblockLaneConflict,
  resolveTimeblockDestination,
  useActivityMedianDurations,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { formatTimeString } from '@/lib/date';
import { convertFromTimezone, convertToTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { toast } from '@/lib/toast';

/** 開始時刻の既定: 対象日が今日なら現在時刻を次の 1 分境界へ ceil、それ以外は 09:00 */
function defaultStartAt(forDate: Date | undefined, timezone: string): Date {
  const now = new Date();
  if (!forDate || isSameDay(forDate, convertToTimezone(now, timezone))) {
    const ONE_MIN_MS = 60 * 1000;
    return new Date(Math.ceil(now.getTime() / ONE_MIN_MS) * ONE_MIN_MS);
  }
  const start = startOfDay(forDate);
  start.setHours(9, 0, 0, 0);
  return convertFromTimezone(start, timezone);
}

interface ActivityQuickCreateQueue {
  waitingForStats: Set<string>;
  current: Promise<void> | null;
}

const queuesByQueryClient = new WeakMap<object, ActivityQuickCreateQueue>();

function getActivityQuickCreateQueue(queryClient: object): ActivityQuickCreateQueue {
  let queue = queuesByQueryClient.get(queryClient);
  if (!queue) {
    queue = { waitingForStats: new Set(), current: null };
    queuesByQueryClient.set(queryClient, queue);
  }
  return queue;
}

function enqueueQuickCreate(
  queue: ActivityQuickCreateQueue,
  create: () => Promise<void>,
): Promise<void> {
  const task = queue.current ? queue.current.then(create) : create();
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  queue.current = settled;
  void settled.then(() => {
    if (queue.current === settled) queue.current = null;
  });
  return task;
}

interface QuickCreateArgs {
  activityId: string;
  activityName: string;
  /** 作成先の日付。省略時は今日 */
  date?: Date | undefined;
}

/** アクティビティのタップから記録の中央値（無ければ既定）の長さでブロックを作り、詳細パネルを開く */
export function useActivityQuickCreate() {
  const t = useTranslations();
  const { canUseProduct } = useBillingAccess();
  const openSettings = useShellStore.use.openSettings();
  const timezone = useUserPreferences((s) => s.timezone);
  const timeFormat = useUserPreferences((s) => s.timeFormat);
  const defaultDuration = useUserPreferences((s) => s.defaultDuration);
  const { getMedianMinutes, isPending, resolveMedianMinutes } = useActivityMedianDurations();
  const queryClient = useQueryClient();
  const queue = getActivityQuickCreateQueue(queryClient);
  const { createPlan, createRecord, deletePlan, deleteRecord } = useTimeblockWriteMutations();
  const openInspector = useTimeblockInspectorStore((state) => state.openInspector);
  const closeInspector = useTimeblockInspectorStore((state) => state.closeInspector);

  return useCallback(
    ({ activityId, activityName, date }: QuickCreateArgs) => {
      const requestKey = `${activityId}:${date?.getTime() ?? 'today'}`;
      if (queue.waitingForStats.has(requestKey)) return;
      if (!canUseProduct) {
        // 課金の状態は開いた設定画面そのものが説明する。閲覧のみである旨の
        // 説明文をトーストへ流用しても「なぜ作れないか」は伝わらない
        openSettings('billing');
        return;
      }
      const create = async (medianMinutes: number | null) => {
        const defaultStart = defaultStartAt(date, timezone);
        const localStart = convertToTimezone(defaultStart, timezone);
        const durationMinutes = medianMinutes ?? defaultDuration;
        const defaultEnd = new Date(defaultStart.getTime() + durationMinutes * 60 * 1000);
        // 探す範囲はその日の終わりまで。翌日へ飛ばされる方が、作れないより驚く
        const searchLimit = convertFromTimezone(endOfDay(localStart), timezone);

        // 同一レーンのみ禁止（plan×plan / record×record）。plan×record は共存できる。
        // レーンは end_at で決まるので、既定の枠の end_at で先に引く
        const laneItems = collectTimeblockLaneItems(
          queryClient,
          resolveTimeblockDestination(defaultEnd) === 'plan' ? 'plans' : 'records',
        );
        const slot = findFreeTimeblockLaneSlot(
          laneItems,
          defaultStart,
          durationMinutes,
          searchLimit,
        );
        if (!slot) {
          toast.error(t('timeblock.errors.timeOverlap'));
          return;
        }
        const { startAt, endAt } = slot;
        const destination = resolveTimeblockDestination(endAt);
        // ずらしたなら、いつに作ったかを知らせる。DST切替を跨いでも、最終実時刻から
        // 設定timezoneの表示時刻を得る。
        const shiftedMs = startAt.getTime() - defaultStart.getTime();
        const shiftedLocalStart = convertToTimezone(startAt, timezone);

        // ずらした結果 end_at が now を跨いでレーンが変わったら、移った先で見直す
        if (destination !== resolveTimeblockDestination(defaultEnd)) {
          const movedLaneItems = collectTimeblockLaneItems(
            queryClient,
            destination === 'plan' ? 'plans' : 'records',
          );
          if (hasTimeblockLaneConflict(movedLaneItems, startAt, endAt)) {
            toast.error(t('timeblock.errors.timeOverlap'));
            return;
          }
        }

        const mutation = destination === 'plan' ? createPlan : createRecord;
        await mutation.mutateAsync(
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
              // 予定と記録は別のものなので、作ったトーストでも言い分ける。
              // ずらした時は時刻を出す（押した時間と違う場所に現れたことが読める）
              const message =
                shiftedMs > 0
                  ? t(
                      destination === 'plan'
                        ? 'timeblock.editor.toast.planCreatedShifted'
                        : 'timeblock.editor.toast.recordedShifted',
                      {
                        time: formatTimeString(
                          shiftedLocalStart.getHours(),
                          shiftedLocalStart.getMinutes(),
                          timeFormat,
                        ),
                      },
                    )
                  : t(
                      destination === 'plan'
                        ? 'timeblock.editor.toast.planCreated'
                        : 'timeblock.editor.toast.recorded',
                    );
              toast.success(message, {
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
      };
      if (isPending || queue.waitingForStats.size > 0) {
        // 取得待ちの連打で同じ操作を重複作成しない。表示範囲は待たせない。
        queue.waitingForStats.add(requestKey);
        void resolveMedianMinutes(activityId)
          .then((medianMinutes) => {
            // 前の mutation の async onMutate / 保存が完了した cache で次の空きを探す。
            const queued = enqueueQuickCreate(queue, () => create(medianMinutes));
            return queued;
          })
          .catch(() => undefined)
          .finally(() => {
            queue.waitingForStats.delete(requestKey);
          });
        return;
      }
      void enqueueQuickCreate(queue, () => create(getMedianMinutes(activityId))).catch(
        () => undefined,
      );
    },
    [
      canUseProduct,
      openSettings,
      closeInspector,
      createPlan,
      createRecord,
      defaultDuration,
      getMedianMinutes,
      isPending,
      resolveMedianMinutes,
      queue,
      deletePlan,
      deleteRecord,
      openInspector,
      queryClient,
      t,
      timeFormat,
      timezone,
    ],
  );
}
