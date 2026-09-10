'use client';

/**
 * ドラッグ作成（Inspector 作成モード）の entry 作成ロジック
 *
 * ドラッグ選択（pendingSelection）からの plan / record 作成、
 * 新規アクティビティ作成 → entry 作成、選択範囲の live 競合判定を担う。
 *
 * アクティビティのホバーでは色と名前に加えて「普段の長さ」も先出しする。着せ替え先は
 * pendingSelection 自身なので、グリッドのハイライトの厚み・パネルの時刻・重なり判定・
 * 作成される長さが必ず一致する。
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import type { HoveredActivityInfo } from '@/features/activities';
import { useCreateActivity } from '@/features/activities';
import {
  collectTimeblockLaneItems,
  hasTimeblockLaneConflict,
  resolveTimeblockKindChoice,
  useActivityMedianDurations,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
  type Fulfillment,
} from '@/features/timeblock';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { logger } from '@/lib/logger';

import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

/** アクティビティ選択と同時に保存する、作成前に埋めておける値 */
interface InlineCreateExtras {
  note?: string | undefined;
  /** Record にだけ保存する。Plan では無視する */
  fulfillment?: Fulfillment | null | undefined;
}

export function useInlineCreate(extras: InlineCreateExtras = {}) {
  const { note, fulfillment } = extras;
  const pendingSelection = useInlineCreateStore.use.pendingSelection();
  const clearPendingSelection = useInlineCreateStore.use.clearPendingSelection();
  const setHoveredActivity = useInlineCreateStore.use.setHoveredActivity();
  const previewActivityDuration = useInlineCreateStore.use.previewActivityDuration();
  const { getMedianMinutes } = useActivityMedianDurations();
  const timezone = useUserPreferences((s) => s.timezone);
  const t = useTranslations('activities');
  const tEntry = useTranslations('timeblock');

  const queryClient = useQueryClient();
  const openInspector = useTimeblockInspectorStore((state) => state.openInspector);
  const closeInspector = useTimeblockInspectorStore((state) => state.closeInspector);
  const { createRecord, createPlan } = useTimeblockWriteMutations();
  const createActivityMutation = useCreateActivity({ showToast: false });
  const [isCreating, setIsCreating] = useState(false);
  const lockedRef = useRef(false);

  // 選択後はホバークリアを無視（mouseLeaveでちらつかないように）
  const handleActivityHover = useCallback(
    (activity: HoveredActivityInfo | null) => {
      if (activity === null && lockedRef.current) return;
      setHoveredActivity(activity);
      // 色・名前と一緒に長さも着せる。中央値の無いアクティビティ（null）へ移ったら
      // ドラッグで決めた長さへ戻る
      previewActivityDuration(activity ? getMedianMinutes(activity.id) : null);
    },
    [setHoveredActivity, previewActivityDuration, getMedianMinutes],
  );

  // plan / record 作成ハンドラー（アクティビティ必須、その名前をタイトルに設定）
  const handleCreate = useCallback(
    (activityId: string, activityName: string) => {
      if (isCreating) return;

      // ホバーの無い環境（タップ）でも同じ長さで作る。ホバー済みなら同じ値なので
      // 何も動かない。長さを直した後は store 側で no-op になる
      previewActivityDuration(getMedianMinutes(activityId));
      const selection = useInlineCreateStore.getState().pendingSelection;
      if (!selection) return;

      const { date: selDate, startHour, startMinute, endHour, endMinute } = selection;

      // ローカル時刻 → UTC変換
      const localStart = new Date(
        selDate.getFullYear(),
        selDate.getMonth(),
        selDate.getDate(),
        startHour,
        startMinute,
      );
      const localEnd = new Date(
        selDate.getFullYear(),
        selDate.getMonth(),
        selDate.getDate(),
        endHour,
        endMinute,
      );

      const utcStart = convertFromTimezone(localStart, timezone);
      const utcEnd = convertFromTimezone(localEnd, timezone);

      // 既定は end ルール。過去スロットに限りユーザーがタブで選んだ種別を優先する
      // （lane はドラッグ起点の表示ヒントに留める）。
      const { kind: destination } = resolveTimeblockKindChoice(utcEnd, selection.kind);

      // 事前 overlap 判定（セレクタを開いている間の resize / 他クライアント更新による race を回避）
      // 同一レーンのみ禁止（plan×plan / record×record）。plan×record は許可。
      const laneItems = collectTimeblockLaneItems(
        queryClient,
        destination === 'plan' ? 'plans' : 'records',
      );
      if (hasTimeblockLaneConflict(laneItems, utcStart, utcEnd)) {
        // パネルは開いたままにする。時間を直して選び直せる
        toast.error(tEntry('errors.timeOverlap'));
        return;
      }

      lockedRef.current = true;
      setIsCreating(true);

      logger.log('🏷️ InlineCreate: Creating', {
        destination,
        start: utcStart.toISOString(),
        end: utcEnd.toISOString(),
        activityId,
        title: activityName,
      });

      const trimmedNote = note?.trim();
      const mutation = destination === 'plan' ? createPlan : createRecord;
      mutation.mutate(
        {
          title: activityName,
          start_at: utcStart.toISOString(),
          end_at: utcEnd.toISOString(),
          activityId,
          ...(trimmedNote ? { note: trimmedNote } : {}),
          // 充実度は Record だけが持つ。Plan へ渡すと schema で弾かれる
          ...(destination === 'record' && fulfillment ? { fulfillment } : {}),
        },
        {
          onSuccess: (created) => {
            setIsCreating(false);
            lockedRef.current = false;
            clearPendingSelection();
            toast.success(
              destination === 'plan'
                ? tEntry('editor.toast.planCreated')
                : tEntry('editor.toast.recorded'),
            );
            // 同じパネルをそのまま作成したブロックの詳細へ切り替える。メモ入力や
            // 記録化へ続けて進めるようにするため（作成モードはここで終わる）
            if (created?.id) {
              openInspector(created.id, destination);
            } else {
              closeInspector();
            }
          },
          // 失敗時はパネルを閉じない。時間や種別を直して選び直せる
          onError: () => {
            setIsCreating(false);
            lockedRef.current = false;
          },
        },
      );
    },
    [
      isCreating,
      previewActivityDuration,
      getMedianMinutes,
      timezone,
      note,
      fulfillment,
      createPlan,
      createRecord,
      clearPendingSelection,
      closeInspector,
      openInspector,
      queryClient,
      tEntry,
    ],
  );

  // 新規アクティビティ作成 → エントリ作成
  const handleCreateAndSelect = useCallback(
    async (
      name: string,
      _color?: string | null,
      _icon?: string | null,
      categoryId?: string | null,
    ) => {
      if (!pendingSelection || isCreating) return;

      setIsCreating(true);
      try {
        // 色・アイコンはカテゴリーだけが持つ（#2162 §4-6）。アクティビティ側には保存しない
        const created = await createActivityMutation.mutateAsync({
          name,
          categoryId: categoryId ?? undefined,
        });
        // mutateAsync resolved → handleCreate で続行
        handleCreate(created.id, name);
      } catch (err) {
        setIsCreating(false);
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('duplicate') || message.includes('already exists')) {
          toast.error(t('activity.duplicateName'));
        } else {
          toast.error(t('activity.createFailed'));
        }
      }
    },
    [pendingSelection, isCreating, createActivityMutation, handleCreate, t],
  );

  // 現在の selection が他 entry と重なるかを live 判定（resize や外部更新に追随）。
  const hasConflict = useMemo(() => {
    if (!pendingSelection) return false;
    const { date: selDate, startHour, startMinute, endHour, endMinute } = pendingSelection;
    const startMin = startHour * 60 + startMinute;
    const endMin = endHour * 60 + endMinute;
    if (endMin <= startMin) return false;

    const localStart = new Date(
      selDate.getFullYear(),
      selDate.getMonth(),
      selDate.getDate(),
      startHour,
      startMinute,
    );
    const localEnd = new Date(
      selDate.getFullYear(),
      selDate.getMonth(),
      selDate.getDate(),
      endHour,
      endMinute,
    );
    const utcStart = convertFromTimezone(localStart, timezone);
    const utcEnd = convertFromTimezone(localEnd, timezone);

    // 保存先レーンと同じレーンのみ判定（plan×record は共存可）
    const { kind: destination } = resolveTimeblockKindChoice(utcEnd, pendingSelection.kind);
    const laneItems = collectTimeblockLaneItems(
      queryClient,
      destination === 'plan' ? 'plans' : 'records',
    );
    return hasTimeblockLaneConflict(laneItems, utcStart, utcEnd);
  }, [queryClient, pendingSelection, timezone]);

  return {
    isCreating,
    handleActivityHover,
    handleCreate,
    handleCreateAndSelect,
    hasConflict,
  };
}
