'use client';

/**
 * Calendar Composition Hook
 *
 * CalendarControllerに必要な全データ・コールバックを集約する薄いオーケストレーター。
 * 実ロジックは専用サブフックに委譲し、副作用（タイムゾーン初期化・Inspector連動等）のみ保持する。
 *
 * Sub-hooks:
 * - useCalendarDataLayer: データ取得・フィルタリング
 * - useCalendarCrudHandlers: Timeblock CRUD・キーボードショートカット
 * - useCalendarNavHandlers: ナビゲーション・設定永続化
 *
 * @see docs/product/specs/calendar.md
 */

import React, { useCallback, useEffect, useMemo } from 'react';

// Feature barrel imports（side-effect用）
import type { CalendarViewType, UserSettings } from '@/features/calendar';
import { useCalendarNavigationStore } from '@/features/calendar';
import { useTimeblockInspectorStore } from '@/features/timeblock';
import { logger } from '@/lib/logger';

// Sub-hooks
import { useCalendarCrudHandlers } from './useCalendarCrudHandlers';
import { useCalendarDataLayer } from './useCalendarDataLayer';
import { useCalendarNavHandlers } from './useCalendarNavHandlers';

// =============================================================================
// Types
// =============================================================================

interface CalendarCompositionInput {
  /** 現在のビュータイプ */
  viewType: CalendarViewType;
  /** 現在の表示日付 */
  currentDate: Date;
  /** 相対ナビゲーション */
  navigateRelative: (direction: 'prev' | 'next' | 'today', showWeekends?: boolean) => void;
  /** 日付指定ナビゲーション */
  navigateToDate: (date: Date) => void;
  /** ビュー変更 */
  changeView: (view: CalendarViewType) => void;
}

interface CalendarCompositionResult {
  // === Data ===
  viewDateRange: ReturnType<typeof useCalendarDataLayer>['viewDateRange'];
  filteredEvents: ReturnType<typeof useCalendarDataLayer>['filteredEvents'];
  allCalendarEvents: ReturnType<typeof useCalendarDataLayer>['allCalendarEvents'];
  externalEvents: ReturnType<typeof useCalendarDataLayer>['externalEvents'];
  prefetchDirection: ReturnType<typeof useCalendarDataLayer>['prefetchDirection'];

  // === Settings ===
  showWeekends: boolean;

  // === Timeblock state ===
  disabledTimeblockId: string | null;

  // === Timeblock click handlers ===
  onEntryClick: ReturnType<typeof useCalendarCrudHandlers>['onEntryClick'];
  onTimeRangeSelect: ReturnType<typeof useCalendarCrudHandlers>['onTimeRangeSelect'];

  // === Timeblock CRUD ===
  onUpdateEntry: ReturnType<typeof useCalendarCrudHandlers>['onUpdateEntry'];
  onDeleteTimeblock: ReturnType<typeof useCalendarCrudHandlers>['onDeleteTimeblock'];

  // === Context menu actions ===
  onDeleteTimeblockConfirm: ReturnType<typeof useCalendarCrudHandlers>['onDeleteTimeblockConfirm'];
  onViewStats: ReturnType<typeof useCalendarCrudHandlers>['onViewStats'];
  onCopy: ReturnType<typeof useCalendarCrudHandlers>['onCopy'];

  // === Navigation handlers ===
  onNavigate: ReturnType<typeof useCalendarNavHandlers>['onNavigate'];
  onViewChange: ReturnType<typeof useCalendarNavHandlers>['onViewChange'];
  onNavigatePrev: ReturnType<typeof useCalendarNavHandlers>['onNavigatePrev'];
  onNavigateNext: ReturnType<typeof useCalendarNavHandlers>['onNavigateNext'];
  onNavigateToday: ReturnType<typeof useCalendarNavHandlers>['onNavigateToday'];
  onToggleWeekends: ReturnType<typeof useCalendarNavHandlers>['onToggleWeekends'];
  onDateSelect: ReturnType<typeof useCalendarNavHandlers>['onDateSelect'];

  // === Settings persistence ===
  onSettingsChange: (settings: Partial<UserSettings>) => void;
}

// =============================================================================
// Composition Hook
// =============================================================================

export function useCalendarComposition({
  viewType,
  currentDate,
  navigateRelative,
  navigateToDate,
  changeView,
}: CalendarCompositionInput): CalendarCompositionResult {
  // =========================================================================
  // Side Effects: Inspector cleanup on date navigation
  // =========================================================================
  const selectedTimeblockId = useTimeblockInspectorStore((state) => state.timeblockId);
  const closeInspector = useTimeblockInspectorStore((state) => state.closeInspector);

  const prevDateRef = React.useRef(currentDate);
  useEffect(() => {
    if (prevDateRef.current !== currentDate) {
      prevDateRef.current = currentDate;
      closeInspector();
    }
  }, [currentDate, closeInspector]);

  // =========================================================================
  // Side Effects: External navigation sync (search → calendar)
  // =========================================================================
  const pendingDate = useCalendarNavigationStore((s) => s.pendingDate);
  const clearPending = useCalendarNavigationStore((s) => s.clearPending);

  useEffect(() => {
    if (pendingDate) {
      navigateToDate(pendingDate);
      clearPending();
    }
  }, [pendingDate, navigateToDate, clearPending]);

  // =========================================================================
  // Sub-hooks
  // =========================================================================
  const navHandlers = useCalendarNavHandlers({
    viewType,
    currentDate,
    navigateRelative,
    navigateToDate,
    changeView,
  });

  const dataLayer = useCalendarDataLayer({
    viewType,
    currentDate,
    showWeekends: navHandlers.showWeekends,
  });

  const crudHandlers = useCalendarCrudHandlers({
    selectedTimeblockId,
    filteredEvents: dataLayer.filteredEvents,
    currentDate,
  });

  // =========================================================================
  // Debug logging（初回マウント時のみ）
  // =========================================================================
  useEffect(() => {
    logger.log('CalendarComposition initialized:', { viewType });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回のみ
  }, []);

  // =========================================================================
  // ビュー切り替え時に即座にprefetchを発火するラッパー
  // useEffectの依存配列更新を待たず、切り替えボタンを押した瞬間にデータを取りに行く
  // =========================================================================
  const onViewChangeWithPrefetch = useCallback(
    (newView: CalendarViewType) => {
      navHandlers.onViewChange(newView);
      dataLayer.prefetchForView(newView);
    },
    [navHandlers, dataLayer],
  );

  // =========================================================================
  // Compose result from sub-hook outputs
  // =========================================================================
  return useMemo(
    () => ({
      // Data
      ...dataLayer,

      // Settings
      showWeekends: navHandlers.showWeekends,

      // CRUD + Timeblock state
      ...crudHandlers,

      // Navigation
      onNavigate: navHandlers.onNavigate,
      onViewChange: onViewChangeWithPrefetch,
      onNavigatePrev: navHandlers.onNavigatePrev,
      onNavigateNext: navHandlers.onNavigateNext,
      onNavigateToday: navHandlers.onNavigateToday,
      onToggleWeekends: navHandlers.onToggleWeekends,
      onDateSelect: navHandlers.onDateSelect,
      onSettingsChange: navHandlers.onSettingsChange,
    }),
    [dataLayer, crudHandlers, navHandlers, onViewChangeWithPrefetch],
  );
}
