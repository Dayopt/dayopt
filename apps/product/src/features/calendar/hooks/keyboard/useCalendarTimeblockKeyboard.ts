'use client';

import { useEffect, useRef } from 'react';

import {
  type ClipboardTimeblock,
  resolveTimeblockDestination,
  useTimeblockInspectorStore,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import type { ShortcutDef } from '@/lib/keyboard/shortcut-registry';
import { registerShortcuts } from '@/lib/keyboard/shortcut-registry';
import { logger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { resolveTimeblockClipboardPaste } from '../../lib/timeblock-clipboard-paste';
import { useTimeblockClipboardStore } from '../../stores/useTimeblockClipboardStore';

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
  /** 現在選択中のTimeblockのコピー情報を取得する関数 */
  getSelectedTimeblockForCopy?: () => ClipboardTimeblock | null;
  /** ペースト先の日付を取得する関数（デフォルトは現在表示中の日付） */
  getPasteDateForKeyboard?: () => Date;
}

/**
 * カレンダー用Timeblock操作キーボードショートカット
 *
 * Google Calendar互換のショートカット：
 * - Delete / Backspace: 選択中Timeblockを削除
 * - C: 新規Timeblock作成（現在時刻）
 * - Shift + C: 新規Timeblock作成（時刻指定なし）
 * - Cmd/Ctrl + C: 選択中のTimeblockをコピー
 * - Cmd/Ctrl + V: コピーしたTimeblockをペースト（ドラフトモード）
 * - Escape: Inspectorを閉じる
 */
export function useCalendarEventKeyboard({
  enabled = true,
  onDeleteTimeblock,
  getSelectedTimeblockTitle,
  getInitialTimeblockData,
  getSelectedTimeblockForCopy,
  getPasteDateForKeyboard,
}: UseCalendarTimeblockKeyboardOptions) {
  const t = useTranslations();
  const { isOpen, timeblockId, openInspector, closeInspector } = useTimeblockInspectorStore();
  const { createRecord, createPlan } = useTimeblockWriteMutations();
  // ユーザーの設定タイムゾーン（ペースト時のUTC変換に使用）
  const timezone = useUserPreferences((s: { timezone: string }) => s.timezone);

  // コールバックの最新値を参照
  const onDeleteTimeblockRef = useRef(onDeleteTimeblock);
  const getSelectedTimeblockTitleRef = useRef(getSelectedTimeblockTitle);
  const getInitialTimeblockDataRef = useRef(getInitialTimeblockData);
  const getSelectedTimeblockForCopyRef = useRef(getSelectedTimeblockForCopy);
  const getPasteDateForKeyboardRef = useRef(getPasteDateForKeyboard);
  const createPlanRef = useRef(createPlan);
  const createRecordRef = useRef(createRecord);
  const isOpenRef = useRef(isOpen);
  const timeblockIdRef = useRef(timeblockId);
  const closeInspectorRef = useRef(closeInspector);
  const openInspectorRef = useRef(openInspector);
  const tRef = useRef(t);
  const timezoneRef = useRef(timezone);

  useEffect(() => {
    onDeleteTimeblockRef.current = onDeleteTimeblock;
    getSelectedTimeblockTitleRef.current = getSelectedTimeblockTitle;
    getInitialTimeblockDataRef.current = getInitialTimeblockData;
    getSelectedTimeblockForCopyRef.current = getSelectedTimeblockForCopy;
    getPasteDateForKeyboardRef.current = getPasteDateForKeyboard;
    createPlanRef.current = createPlan;
    createRecordRef.current = createRecord;
    isOpenRef.current = isOpen;
    timeblockIdRef.current = timeblockId;
    closeInspectorRef.current = closeInspector;
    openInspectorRef.current = openInspector;
    tRef.current = t;
    timezoneRef.current = timezone;
  }, [
    onDeleteTimeblock,
    getSelectedTimeblockTitle,
    getInitialTimeblockData,
    getSelectedTimeblockForCopy,
    getPasteDateForKeyboard,
    createPlan,
    createRecord,
    isOpen,
    timeblockId,
    closeInspector,
    openInspector,
    t,
    timezone,
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
        key: 'Cmd+C',
        description: '選択中Timeblockをコピー',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          if (isOpenRef.current && timeblockIdRef.current) {
            const timeblockData = getSelectedTimeblockForCopyRef.current?.();
            if (timeblockData) {
              e.preventDefault();
              useTimeblockClipboardStore.getState().copyTimeblock(timeblockData);
              toast.success(tRef.current('common.toast.copied'));
            }
          }
        },
      },
      {
        key: 'Cmd+V',
        description: 'コピーしたTimeblockをペースト',
        priority: 0,
        handler: (e) => {
          if (isInDialogOrInspector()) return;
          const clipboard = useTimeblockClipboardStore.getState();
          const copiedTimeblock = clipboard.copiedTimeblock;
          if (copiedTimeblock) {
            e.preventDefault();

            const lastClicked = clipboard.lastClickedPosition;
            const targetDate =
              lastClicked?.date ?? getPasteDateForKeyboardRef.current?.() ?? new Date();

            const paste = resolveTimeblockClipboardPaste({
              copiedTimeblock,
              targetDate,
              timezone: timezoneRef.current,
            });
            if (!paste.ok) {
              toast.error(tRef.current(`calendar.clipboard.${paste.reason}`));
              return;
            }

            const onPasted = (result: { id: string } | undefined) => {
              if (result?.id) {
                openInspectorRef.current(result.id, paste.kind);
              }
            };
            const onPasteFailed = () => logger.error('Failed to paste timeblock');
            if (paste.kind === 'plan') {
              createPlanRef.current.mutateAsync(paste.input).then(onPasted).catch(onPasteFailed);
            } else {
              createRecordRef.current.mutateAsync(paste.input).then(onPasted).catch(onPasteFailed);
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
