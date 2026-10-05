'use client';

import { useEffect, useRef } from 'react';

import {
  resolveTimeblockDestination,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import type { ShortcutDef } from '@/lib/keyboard/shortcut-registry';
import { registerShortcuts } from '@/lib/keyboard/shortcut-registry';
import { logger } from '@/lib/logger';
import { useTranslations } from 'next-intl';

/** C / Shift+C quick create の枠長。snap 粒度（1 分）とは独立したプロダクト既定値。 */
const QUICK_CREATE_DURATION_MS = 15 * 60 * 1000;

/** useCalendarEventKeyboard フックのオプション */
interface UseCalendarTimeblockKeyboardOptions {
  /** ショートカットを有効にするか */
  enabled?: boolean;
  /** 現在選択中（Inspector表示中）のTimeblockを削除する関数 */
  onDeleteTimeblock?: (timeblockId: string) => Promise<boolean | void>;
  /** 現在選択中のTimeblockのタイトルを取得する関数 */
  getSelectedTimeblockTitle?: () => string | null;
  /** 新規Timeblock作成時の初期データ取得関数（現在の日時など） */
  getInitialTimeblockData?: () => { start_time?: string; end_time?: string } | undefined;
}

/**
 * カレンダー用Timeblock操作キーボードショートカット
 *
 * Google Calendar互換のショートカット：
 * - Delete / Backspace: 選択中Timeblockを削除
 * - C: 新規Timeblock作成（現在時刻）
 * - Shift + C: 新規Timeblock作成（時刻指定なし）
 * - Escape: Inspectorを閉じる
 */
export function useCalendarEventKeyboard({
  enabled = true,
  onDeleteTimeblock,
  getSelectedTimeblockTitle,
  getInitialTimeblockData,
}: UseCalendarTimeblockKeyboardOptions) {
  const t = useTranslations();
  const { isOpen, timeblockId, openInspector, closeInspector } = useTimeblockInspectorStore();
  const { createRecord, createPlan } = useTimeblockWriteMutations();
  // コールバックの最新値を参照
  const onDeleteTimeblockRef = useRef(onDeleteTimeblock);
  const getSelectedTimeblockTitleRef = useRef(getSelectedTimeblockTitle);
  const getInitialTimeblockDataRef = useRef(getInitialTimeblockData);
  const createPlanRef = useRef(createPlan);
  const createRecordRef = useRef(createRecord);
  const isOpenRef = useRef(isOpen);
  const timeblockIdRef = useRef(timeblockId);
  const closeInspectorRef = useRef(closeInspector);
  const openInspectorRef = useRef(openInspector);
  const tRef = useRef(t);

  useEffect(() => {
    onDeleteTimeblockRef.current = onDeleteTimeblock;
    getSelectedTimeblockTitleRef.current = getSelectedTimeblockTitle;
    getInitialTimeblockDataRef.current = getInitialTimeblockData;
    createPlanRef.current = createPlan;
    createRecordRef.current = createRecord;
    isOpenRef.current = isOpen;
    timeblockIdRef.current = timeblockId;
    closeInspectorRef.current = closeInspector;
    openInspectorRef.current = openInspector;
    tRef.current = t;
  }, [
    onDeleteTimeblock,
    getSelectedTimeblockTitle,
    getInitialTimeblockData,
    createPlan,
    createRecord,
    isOpen,
    timeblockId,
    closeInspector,
    openInspector,
    t,
  ]);

  useEffect(() => {
    if (!enabled) return;

    /** dialog/inspector内かどうかを判定 */
    const isInDialogOrInspector = (): boolean => {
      const target = document.activeElement;
      if (!target) return false;
      return (
        target.closest('[role="dialog"]') !== null || target.closest('[data-inspector]') !== null
      );
    };

    const shortcuts: ShortcutDef[] = [
      {
        key: 'Escape',
        description: 'Inspectorを閉じる',
        priority: 0,
        handler: (e) => {
          if (isOpenRef.current) {
            e.preventDefault();
            closeInspectorRef.current();
          }
        },
      },
      {
        key: 'Delete',
        description: '選択中Timeblockを削除',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          if (isOpenRef.current && timeblockIdRef.current) {
            e.preventDefault();
            const deleteCallback = onDeleteTimeblockRef.current;
            if (deleteCallback) {
              const deletingTimeblockId = timeblockIdRef.current;
              void deleteCallback(deletingTimeblockId)
                .then((deleted) => {
                  if (deleted !== false && timeblockIdRef.current === deletingTimeblockId) {
                    closeInspectorRef.current();
                  }
                })
                .catch(() => logger.error('Failed to delete timeblock'));
            }
          }
        },
      },
      {
        key: 'Backspace',
        description: '選択中Timeblockを削除（Backspace）',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          if (isOpenRef.current && timeblockIdRef.current) {
            e.preventDefault();
            const deleteCallback = onDeleteTimeblockRef.current;
            if (deleteCallback) {
              const deletingTimeblockId = timeblockIdRef.current;
              void deleteCallback(deletingTimeblockId)
                .then((deleted) => {
                  if (deleted !== false && timeblockIdRef.current === deletingTimeblockId) {
                    closeInspectorRef.current();
                  }
                })
                .catch(() => logger.error('Failed to delete timeblock'));
            }
          }
        },
      },
      {
        key: 'C',
        description: '新規Timeblock作成',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          e.preventDefault();

          // 未来15分の枠を既定にする（quick create は必ず時間範囲を持つ time model の制約に合わせる）
          // 開始は次の 1 分境界に ceil（秒ノイズと past 判定揺れの回避）
          const now = new Date();
          const roundedStart = new Date(Math.ceil(now.getTime() / (60 * 1000)) * 60 * 1000);
          const defaultEnd = new Date(roundedStart.getTime() + QUICK_CREATE_DURATION_MS);

          const initialData = e.shiftKey ? undefined : getInitialTimeblockDataRef.current?.();
          const startAt = initialData?.start_time ?? roundedStart.toISOString();
          const endAt = initialData?.end_time ?? defaultEnd.toISOString();
          const destination = resolveTimeblockDestination(endAt);
          const createInput = {
            title: tRef.current('timeblock.untitled'),
            start_at: startAt,
            end_at: endAt,
          };
          const onCreated = (result: { id: string } | undefined) => {
            if (result?.id) {
              openInspectorRef.current(result.id, destination);
            }
          };
          const onCreateFailed = () => logger.error('Failed to create timeblock');
          if (destination === 'plan') {
            createPlanRef.current.mutateAsync(createInput).then(onCreated).catch(onCreateFailed);
          } else {
            createRecordRef.current.mutateAsync(createInput).then(onCreated).catch(onCreateFailed);
          }
        },
      },
      {
        key: 'Shift+C',
        description: '新規Timeblock作成（現在時刻から15分）',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          e.preventDefault();

          const now = new Date();
          const roundedStart = new Date(Math.ceil(now.getTime() / (60 * 1000)) * 60 * 1000);
          const endAt = new Date(roundedStart.getTime() + QUICK_CREATE_DURATION_MS).toISOString();
          const destination = resolveTimeblockDestination(endAt);
          const createInput = {
            title: tRef.current('timeblock.untitled'),
            start_at: roundedStart.toISOString(),
            end_at: endAt,
          };
          const onCreated = (result: { id: string } | undefined) => {
            if (result?.id) {
              openInspectorRef.current(result.id, destination);
            }
          };
          const onCreateFailed = () => logger.error('Failed to create timeblock');
          if (destination === 'plan') {
            createPlanRef.current.mutateAsync(createInput).then(onCreated).catch(onCreateFailed);
          } else {
            createRecordRef.current.mutateAsync(createInput).then(onCreated).catch(onCreateFailed);
          }
        },
      },
    ];

    return registerShortcuts(shortcuts);
  }, [enabled]);
}
