'use client';

/**
 * CalendarController - Calendar View Shell
 *
 * composition layerからprops経由でデータ・コールバックを受け取り、
 * キーボードショートカット・コンテキストメニュー・DnDを設定してUIをレンダリングする。
 *
 * @see _composition/useCalendarComposition.ts
 */

import { useCallback, useMemo, useState } from 'react';

import type { ExternalCalendarEvent } from '@/features/external-calendar';
import {
  createTimeblockDuplicateDraft,
  deriveTemplateBlocksFromDay,
  resolveTimeblockDestination,
  usePlanTemplateMutations,
  useTimeblockInspectorStore,
} from '@/features/timeblock';
import { getDateKey } from '@/lib/date';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { CalendarTimeblockActionsProvider } from '../contexts/CalendarTimeblockActionsContext';
import { useCalendarKeyboard } from '../hooks/keyboard/useCalendarKeyboard';
import { useCalendarContextMenu } from '../hooks/useCalendarContextMenu';
import type {
  CalendarDisplayEvent,
  CalendarViewType,
  ViewDateRange,
} from '../types/calendar.types';

import { CalendarViewRenderer } from './controller/components';
import { initializePreload } from './controller/utils';
import { SaveAsTemplateHeader } from './templates/SaveAsTemplateHeader';

import type { UserSettings } from '@/features/calendar/stores/userSettings';
import { CalendarLayout } from './layout/CalendarLayout';
import { EventContextMenu, MobileTouchHint } from './views/shared/components';

// 初回ロード時にビューをプリロード
initializePreload();

// diff ハイライトを点灯させる経路が無くなったため、常にこの空集合を渡す
// （#2181 Step 6）。render のたびに new Set() すると参照が変わり無駄な再計算を招く。
const EMPTY_DAY_DIFF_ENTRY_IDS: ReadonlySet<string> = new Set();

// =============================================================================
// Props
// =============================================================================

/** CalendarController コンポーネントのプロパティ */
interface CalendarControllerProps {
  /** ビュータイプ */
  viewType: CalendarViewType;
  /** 現在の表示日付 */
  currentDate: Date;

  // --- Data ---
  viewDateRange: ViewDateRange;
  filteredTimeblocks: CalendarDisplayEvent[];
  allTimeblocks: CalendarDisplayEvent[];
  /** 外部カレンダーの未変換予定（ghost）。読み取り専用で tag フィルタの対象外 */
  externalEvents?: ExternalCalendarEvent[] | undefined;

  // --- Settings ---
  showWeekends: boolean;

  // --- Timeblock state ---
  disabledTimeblockId: string | null;

  // --- Timeblock click handlers ---
  onEntryClick: (entry: CalendarDisplayEvent) => void;
  onTimeRangeSelect: (selection: {
    date: Date;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
  }) => void;

  // --- Timeblock CRUD ---
  onUpdateEntry: (
    timeblockIdOrTimeblock: string | CalendarDisplayEvent,
    updates?: {
      startTime: Date;
      endTime: Date;
      resetActualTime?: boolean;
    },
  ) => void | Promise<void> | Promise<{ skipToast: true } | void>;
  onDeleteTimeblock: (timeblockId: string) => void;

  // --- Context menu actions ---
  onDeleteTimeblockConfirm: (entry: CalendarDisplayEvent) => void;
  onViewStats: (entry: CalendarDisplayEvent) => void;
  onCopy: (entry: CalendarDisplayEvent) => void;

  // --- Navigation handlers ---
  onNavigate: (direction: 'prev' | 'next' | 'today') => void;
  onViewChange: (newView: CalendarViewType) => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onNavigateToday: () => void;
  onToggleWeekends: () => void;
  onDateSelect: (date: Date) => void;

  // --- Prefetch ---
  onPrefetch?: ((direction: 'prev' | 'next' | 'today') => void) | undefined;

  // --- Settings persistence ---
  onSettingsChange?: (settings: Partial<UserSettings>) => void;

  // --- Slots ---
  className?: string;
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
}

// =============================================================================
// Component
// =============================================================================

export function CalendarController({
  viewType,
  currentDate,
  viewDateRange,
  filteredTimeblocks,
  allTimeblocks,
  externalEvents,
  showWeekends,
  disabledTimeblockId,
  onEntryClick,
  onTimeRangeSelect,
  onUpdateEntry,
  onDeleteTimeblock,
  onDeleteTimeblockConfirm,
  onViewStats,
  onCopy,
  onNavigate,
  onViewChange,
  onNavigatePrev,
  onNavigateNext,
  onNavigateToday,
  onToggleWeekends,
  onPrefetch,
  onSettingsChange,
  onDateSelect,
  className,
  leftSlot,
  rightSlot,
}: CalendarControllerProps) {
  // =========================================================================
  // Calendar-internal hooks
  // =========================================================================

  const openDuplicateInspector = useTimeblockInspectorStore((state) => state.openDuplicate);

  // =========================================================================
  // テンプレート（型）の保存（#2567）
  // =========================================================================
  // 保存中はヘッダーの中身だけを名前入力へ差し替える。メインの盤面は触らない
  // （保存されるのは「今見えている日の盤面そのもの」という関係を UI で保つ）。
  const [savingDateKey, setSavingDateKey] = useState<string | null>(null);
  const timezone = useUserPreferences((preferences) => preferences.timezone);
  const { createTemplate } = usePlanTemplateMutations();

  // `currentDate` は壁時計 Date（navigation 由来）なので timezone 無しで暦日を読む（#2017）
  const templateDateKey = getDateKey(currentDate);
  const templateDayBlocks = useMemo(
    () => deriveTemplateBlocksFromDay(allTimeblocks, templateDateKey, timezone),
    [allTimeblocks, templateDateKey, timezone],
  );

  // 保存対象は「今見えている日」。開いた時の日から動いたら（キーボード移動・URL 変更・
  // ビュー切替のどれでも）ヘッダーを閉じる。開いたままにすると、ユーザーが意図した日と
  // 実際に保存される日がずれる。state ではなく導出で持ち、閉じ忘れの経路を作らない。
  const isSavingAsTemplate = savingDateKey === templateDateKey && viewType === 'day';

  const closeSaveAsTemplate = useCallback(() => setSavingDateKey(null), []);

  // 移動系は保存状態を落としてから元のハンドラへ渡す（同じ日へ戻った時に
  // 空のヘッダーが復活しないようにする）
  const handleNavigate = useCallback(
    (direction: 'prev' | 'next' | 'today') => {
      closeSaveAsTemplate();
      onNavigate(direction);
    },
    [closeSaveAsTemplate, onNavigate],
  );

  const handleViewChange = useCallback(
    (newView: CalendarViewType) => {
      closeSaveAsTemplate();
      onViewChange(newView);
    },
    [closeSaveAsTemplate, onViewChange],
  );

  const handleDateSelect = useCallback(
    (date: Date) => {
      closeSaveAsTemplate();
      onDateSelect(date);
    },
    [closeSaveAsTemplate, onDateSelect],
  );

  const handleSaveAsTemplate = useCallback(
    (name: string) => {
      createTemplate.mutate(
        { name, blocks: templateDayBlocks },
        { onSuccess: closeSaveAsTemplate },
      );
    },
    [closeSaveAsTemplate, createTemplate, templateDayBlocks],
  );

  // コンテキストメニュー管理
  const { contextMenuEvent, contextMenuPosition, handleEventContextMenu, handleCloseContextMenu } =
    useCalendarContextMenu();
  const handleDuplicate = useCallback(
    (entry: CalendarDisplayEvent) => {
      const startAt = entry.startDate ?? entry.displayStartDate;
      const endAt = entry.endDate ?? entry.displayEndDate;
      const kind = entry.kind ?? resolveTimeblockDestination(endAt);
      openDuplicateInspector(
        createTimeblockDuplicateDraft({
          sourceId: entry.id,
          kind,
          title: entry.title,
          note: entry.description ?? null,
          activityId: entry.activityId,
          startAt,
          endAt,
        }),
      );
    },
    [openDuplicateInspector],
  );
  // キーボードショートカット（ビューナビゲーション用）
  useCalendarKeyboard({
    viewType,
    onNavigate: handleNavigate,
    onViewChange: handleViewChange,
    onToggleWeekends,
  });

  // =========================================================================
  // エントリ操作ハンドラ（Context経由で配信 — View以下でprops不要）
  const timeblockActions = useMemo(
    () => ({
      onEntryClick,
      onEntryContextMenu: handleEventContextMenu,
      onUpdateEntry,
      onDeleteTimeblock,
      onTimeRangeSelect,
      disabledTimeblockId,
    }),
    [
      onEntryClick,
      handleEventContextMenu,
      onUpdateEntry,
      onDeleteTimeblock,
      onTimeRangeSelect,
      disabledTimeblockId,
    ],
  );

  // View props（データ + ナビゲーションのみ。エントリ操作はContext経由）
  const commonProps = useMemo(
    () => ({
      dateRange: viewDateRange,
      entries: filteredTimeblocks,
      allTimeblocks,
      externalEvents,
      currentDate,
      showWeekends,
      // カレンダー内 review/diff パネル（CalendarReviewRail）は廃止済み（#2181 Step 6）。
      // グリッドの diff ハイライト自体は View 層に残すが、点灯させる経路が無くなったため常に空。
      showActualDiff: false,
      dayDiffEntryIds: EMPTY_DAY_DIFF_ENTRY_IDS,
      disabledTimeblockId,
      onEntryClick,
      onEntryContextMenu: handleEventContextMenu,
      onUpdateEntry,
      onDeleteTimeblock,
      onTimeRangeSelect,
      onViewChange,
      onNavigatePrev,
      onNavigateNext,
      onNavigateToday,
    }),
    [
      viewDateRange,
      filteredTimeblocks,
      allTimeblocks,
      externalEvents,
      currentDate,
      showWeekends,
      disabledTimeblockId,
      onEntryClick,
      handleEventContextMenu,
      onUpdateEntry,
      onDeleteTimeblock,
      onTimeRangeSelect,
      onViewChange,
      onNavigatePrev,
      onNavigateNext,
      onNavigateToday,
    ],
  );

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <CalendarTimeblockActionsProvider value={timeblockActions}>
      <CalendarLayout
        className={className}
        viewType={viewType}
        currentDate={currentDate}
        onNavigate={handleNavigate}
        onViewChange={handleViewChange}
        onDateSelect={handleDateSelect}
        displayRange={{
          start: viewDateRange.start,
          end: viewDateRange.end,
        }}
        onPrefetch={onPrefetch}
        onSettingsChange={onSettingsChange}
        leftSlot={leftSlot}
        rightSlot={rightSlot}
        headerReplacement={
          isSavingAsTemplate ? (
            <SaveAsTemplateHeader
              onSave={handleSaveAsTemplate}
              onCancel={closeSaveAsTemplate}
              isSaving={createTemplate.isPending}
            />
          ) : undefined
        }
        onSaveAsTemplate={() => setSavingDateKey(templateDateKey)}
        saveAsTemplateDisabled={templateDayBlocks.length === 0}
      >
        <CalendarViewRenderer viewType={viewType} commonProps={commonProps} />
      </CalendarLayout>

      {contextMenuEvent && contextMenuPosition ? (
        <EventContextMenu
          entry={contextMenuEvent}
          position={contextMenuPosition}
          onClose={handleCloseContextMenu}
          onDelete={onDeleteTimeblockConfirm}
          onViewStats={onViewStats}
          onCopy={onCopy}
          onDuplicate={handleDuplicate}
        />
      ) : null}

      {/* モバイル操作ヒント（初回のみ表示） */}
      <MobileTouchHint />
    </CalendarTimeblockActionsProvider>
  );
}
