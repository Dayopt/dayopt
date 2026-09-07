'use client';

/**
 * Calendar CRUD Handlers Hook
 *
 * Timeblock のクリック・作成・更新・削除・コンテキストメニュー操作を担当。
 * キーボードショートカット（Timeblock操作系）もここに集約。
 */

import { useCallback, useMemo } from 'react';

import { addHours, startOfHour } from 'date-fns';
import { useTranslations } from 'next-intl';

import type { CalendarDisplayEvent } from '@/features/calendar';
import {
  useCalendarEventKeyboard,
  useCalendarHandlers,
  useTimeblockClipboardStore,
  useTimeblockContextActions,
  useTimeblockOperations,
} from '@/features/calendar';
import { toast } from '@/lib/toast';

import { createCalendarEventClipboardTimeblock } from './createCalendarEventClipboardTimeblock';

// =============================================================================
// Types
// =============================================================================

interface CalendarCrudHandlersInput {
  /** Inspector で選択中の Timeblock ID */
  selectedTimeblockId: string | null;
  /** フィルタ済みイベント一覧（キーボード操作でタイトル取得に使用） */
  filteredEvents: CalendarDisplayEvent[];
  /** 現在の表示日付（キーボード操作で過去日判定に使用） */
  currentDate: Date;
}

interface CalendarCrudHandlersResult {
  disabledTimeblockId: string | null;
  onEntryClick: (entry: CalendarDisplayEvent) => void;
  onTimeRangeSelect: (selection: {
    date: Date;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
  }) => void;
  onUpdateEntry: (
    timeblockIdOrTimeblock: string | CalendarDisplayEvent,
    updates?: {
      startTime: Date;
      endTime: Date;
      resetActualTime?: boolean;
      expectedUpdatedAt?: string;
    },
  ) => void | Promise<void> | Promise<{ skipToast: true } | void>;
  onDeleteTimeblock: (timeblockId: string) => Promise<boolean>;
  onDeleteTimeblockConfirm: (entry: CalendarDisplayEvent) => void;
  onViewStats: (entry: CalendarDisplayEvent) => void;
  onCopy: (entry: CalendarDisplayEvent) => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useCalendarCrudHandlers({
  selectedTimeblockId,
  filteredEvents,
  currentDate,
}: CalendarCrudHandlersInput): CalendarCrudHandlersResult {
  const t = useTranslations();
  const copyTimeblock = useTimeblockClipboardStore((state) => state.copyTimeblock);
  // =========================================================================
  // Calendar Handlers（click, create, drag-select）
  // =========================================================================
  const { handleTimeblockClick, handleDateTimeRangeSelect, disabledTimeblockId } =
    useCalendarHandlers();

  // =========================================================================
  // Timeblock Operations（CRUD）
  // =========================================================================
  const { handleTimeblockDelete: deleteTimeblock, handleUpdateTimeblock: handleTimeblockUpdate } =
    useTimeblockOperations();

  // =========================================================================
  // Context Actions（右クリックメニュー）
  // =========================================================================
  const { handleDeleteTimeblock: handleDeleteTimeblockConfirm, handleViewStats } =
    useTimeblockContextActions();

  // =========================================================================
  // Timeblock Keyboard Shortcuts
  // =========================================================================
  const getInitialEntryData = useCallback((): { start_time?: string; end_time?: string } => {
    const now = new Date();
    const start = startOfHour(now);
    const end = addHours(start, 1);
    return {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    };
  }, []);

  const getSelectedEntryTitle = useCallback(() => {
    if (!selectedTimeblockId) return null;
    const entry = filteredEvents.find((p) => p.id === selectedTimeblockId);
    return entry?.title ?? null;
  }, [selectedTimeblockId, filteredEvents]);

  const getSelectedEntryForCopy = useCallback(() => {
    if (!selectedTimeblockId) return null;
    const entry = filteredEvents.find((p) => p.id === selectedTimeblockId);
    return entry ? createCalendarEventClipboardTimeblock(entry) : null;
  }, [selectedTimeblockId, filteredEvents]);

  const handleCopy = useCallback(
    (entry: CalendarDisplayEvent) => {
      const timeblock = createCalendarEventClipboardTimeblock(entry);
      if (!timeblock) return;
      copyTimeblock(timeblock);
      toast.success(t('common.toast.copied'));
    },
    [copyTimeblock, t],
  );

  const getPasteDateForKeyboard = useCallback(() => {
    return currentDate;
  }, [currentDate]);

  const deleteTimeblockAsync = useCallback(
    (timeblockId: string) => deleteTimeblock(timeblockId),
    [deleteTimeblock],
  );

  useCalendarEventKeyboard({
    enabled: true,
    onDeleteTimeblock: deleteTimeblockAsync,
    getSelectedEntryTitle,
    getInitialEntryData,
    getSelectedEntryForCopy,
    getPasteDateForKeyboard,
  });

  // =========================================================================
  // Stable result
  // =========================================================================
  return useMemo(
    () => ({
      disabledTimeblockId,
      onEntryClick: handleTimeblockClick,
      onTimeRangeSelect: handleDateTimeRangeSelect,
      onUpdateEntry: handleTimeblockUpdate,
      onDeleteTimeblock: deleteTimeblock,
      onDeleteTimeblockConfirm: handleDeleteTimeblockConfirm,
      onViewStats: handleViewStats,
      onCopy: handleCopy,
    }),
    [
      disabledTimeblockId,
      handleTimeblockClick,
      handleDateTimeRangeSelect,
      handleTimeblockUpdate,
      deleteTimeblock,
      handleDeleteTimeblockConfirm,
      handleViewStats,
      handleCopy,
    ],
  );
}
