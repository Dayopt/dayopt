'use client';

import { useCallback } from 'react';

import { useTimeblockInspectorStore } from '@/features/timeblock';
import { logger } from '@/lib/logger';
import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../../../domain/precision';
import { useInlineCreateStore } from '../../../stores/useInlineCreateStore';

import type { CalendarDisplayEvent } from '../../../types/calendar.types';
import type { DateTimeSelection } from '../../views/shared';

/** エントリクリック・時間範囲選択など、カレンダー共通のUIイベントハンドラーを提供するフック */
export function useCalendarHandlers() {
  const openTimeblockInspector = useTimeblockInspectorStore((state) => state.openInspector);
  const openCreateInspector = useTimeblockInspectorStore((state) => state.openCreate);
  const inspectorEntryId = useTimeblockInspectorStore((state) => state.timeblockId);
  const inspectorIsOpen = useTimeblockInspectorStore((state) => state.isOpen);

  const setPendingSelection = useInlineCreateStore.use.setPendingSelection();

  // Inspector で開いているTimeblockIDをDnD無効化用に計算
  const disabledTimeblockId = inspectorIsOpen ? inspectorEntryId : null;

  // エントリクリックハンドラー
  const handleTimeblockClick = useCallback(
    (entry: CalendarDisplayEvent) => {
      openTimeblockInspector(entry.id, entry.kind ?? 'plan');

      logger.log('Opening Timeblock Inspector:', {
        timeblockId: entry.id,
        title: entry.title,
        kind: entry.kind,
      });
    },
    [openTimeblockInspector],
  );

  // 統一された時間範囲選択ハンドラー（全ビュー共通）
  // ドラッグ/ダブルクリック/タップ → グリッド上のハイライト + Inspector 作成モード
  const handleDateTimeRangeSelect = useCallback(
    (selection: DateTimeSelection) => {
      // 最小ブロック長制約の適用
      const startMinutes = selection.startHour * 60 + selection.startMinute;
      let endMinutes = selection.endHour * 60 + selection.endMinute;
      if (endMinutes - startMinutes < MIN_TIMEBLOCK_DURATION_MINUTES) {
        endMinutes = startMinutes + MIN_TIMEBLOCK_DURATION_MINUTES;
      }

      logger.log('Calendar Drag Selection:', {
        date: selection.date.toDateString(),
        start: `${selection.startHour}:${String(selection.startMinute).padStart(2, '0')}`,
        end: `${Math.floor(endMinutes / 60)}:${String(endMinutes % 60).padStart(2, '0')}`,
      });

      setPendingSelection({
        date: selection.date,
        startHour: selection.startHour,
        startMinute: selection.startMinute,
        endHour: Math.floor(endMinutes / 60),
        endMinute: endMinutes % 60,
        creationSource: selection.creationSource,
      });
      // 選択と同時に編集と同じパネルを作成モードで開く。閉じる操作は
      // closeInspector → calendar-drag-cancel → pendingSelection 破棄で完結する
      openCreateInspector();
    },
    [openCreateInspector, setPendingSelection],
  );

  return {
    handleTimeblockClick,
    handleDateTimeRangeSelect,
    /** DnDを無効化するTimeblockID（Inspector表示中のTimeblock） */
    disabledTimeblockId,
  };
}
