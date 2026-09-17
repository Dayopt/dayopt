'use client';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import React, { useCallback } from 'react';

import { useActivitiesMap } from '@/features/activities';
import type { ExternalCalendarEvent } from '@/features/external-calendar';
import {
  isPlanRecordDrop,
  resolveTimeblockDestination,
  useTimeblockWriteMutations,
} from '@/features/timeblock';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { cn } from '@dayopt/components';

import { useConvertGhostEvent } from '../../../../hooks/operations/useConvertGhostEvent';
import { useInteraction } from '../../../../interaction';
import { GhostRenderer } from '../../../../interaction/GhostRenderer';
import {
  calendarEventToPlanEvent,
  calendarEventToRecordEvent,
} from '../../../../lib/calendar-event-to-lane-event';
import { selectExternalEventsForDate } from '../../../../lib/external-event-day-selection';
import {
  calculateExternalEventLayout,
  toZonedExternalEvents,
} from '../../../../lib/external-event-layout';
import { buildPlanRecordDropInput } from '../../../../lib/plan-record-drop';
import {
  calculateTwoLaneStylesForCalendarEvents,
  DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  hasLaneCounterpart,
} from '../../../../lib/two-lane-layout';
import { useCalendarDragStore } from '../../../../stores/useCalendarDragStore';
import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { HOURS_PER_DAY } from '../constants/grid.constants';
import { useResponsiveHourHeight } from '../hooks/useResponsiveHourHeight';
import type { DateTimeSelection } from './CalendarDragSelection';
import { CalendarDragSelection } from './CalendarDragSelection';
import { DragSelectionHighlight } from './DragSelectionHighlight';
import { ExternalEventCard } from './TwoLane/ExternalEventCard';
import { PlanLaneCard } from './TwoLane/PlanLaneCard';
import { RecordLaneCard } from './TwoLane/RecordLaneCard';
import { TwoLaneTimeblockRenderer } from './TwoLaneTimeblockRenderer';

// ========================================
// Types
// ========================================

export function buildDragPreviewTimeblock(
  timeblock: CalendarDisplayEvent,
  previewTime: { start: Date; end: Date },
): CalendarDisplayEvent {
  const duration = Math.max(
    1,
    Math.round((previewTime.end.getTime() - previewTime.start.getTime()) / 60000),
  );

  return {
    ...timeblock,
    startDate: previewTime.start,
    endDate: previewTime.end,
    displayStartDate: previewTime.start,
    displayEndDate: previewTime.end,
    duration,
  };
}

/** CalendarGridContent コンポーネントのプロパティ */
interface CalendarGridContentProps {
  /** この列が担当する日付 */
  date: Date;
  /** 表示するタイムブロック一覧 */
  timeblocks: CalendarDisplayEvent[];
  /** ビューモード（useInteraction に渡す） */
  viewMode?: 'day' | '3day' | '5day' | 'week';
  /** この列の日付インデックス（DayView=0, Week/MultiDay=列番号） */
  dayIndex: number;
  /** 重複チェック用の全イベント（週/複数日ビュー用） */
  allEventsForOverlapCheck?: CalendarDisplayEvent[];
  /** 表示日付リスト（週/複数日ビュー用） */
  displayDates?: Date[];
  /** タイムブロッククリック */
  onTimeblockClick?: ((timeblock: CalendarDisplayEvent) => void) | undefined;
  /** タイムブロック右クリック */
  onTimeblockContextMenu?:
    ((timeblock: CalendarDisplayEvent, e: React.MouseEvent) => void) | undefined;
  /** D&D/リサイズ時の更新コールバック */
  onEventUpdate?:
    | ((
        eventId: string,
        updates: {
          startTime: Date;
          endTime: Date;
          resetActualTime?: boolean;
          expectedUpdatedAt?: string;
        },
      ) => Promise<void | { skipToast: true }> | void)
    | undefined;
  /** 時間範囲選択 */
  onTimeRangeSelect?: ((selection: DateTimeSelection) => void) | undefined;
  /** DnDを無効化するTimeblock ID */
  disabledTimeblockId?: string | null | undefined;
  /** compare Rail に出ている timeblock の ID 一覧 */
  dayDiffTimeblockIds?: ReadonlySet<string> | undefined;
  /** モバイルWeekで表示するレーン。選択レーンは日カラム全幅で表示する */
  laneDisplayMode?: 'both' | 'plan' | 'record' | undefined;
  /** 表示範囲分の外部カレンダー予定（ghost）。この日に出す分はここで絞る */
  externalEvents?: ExternalCalendarEvent[] | undefined;
  className?: string | undefined;
}

type CalendarGridViewMode = NonNullable<CalendarGridContentProps['viewMode']>;

export function resolveCalendarLanePresentation(
  viewMode: CalendarGridViewMode,
  laneDisplayMode: 'both' | 'plan' | 'record' = 'both',
): {
  planLaneWidthPercent: number;
  compactCards: boolean;
} {
  const visibleDayCount =
    viewMode === 'day' ? 1 : viewMode === 'week' ? 7 : Number.parseInt(viewMode, 10);

  return {
    planLaneWidthPercent:
      laneDisplayMode === 'plan'
        ? 100
        : laneDisplayMode === 'record'
          ? 0
          : DEFAULT_PLAN_LANE_WIDTH_PERCENT,
    compactCards: visibleDayCount >= 5,
  };
}

// ========================================
// Component
// ========================================

/** カレンダーグリッドの1日分コンテンツ（全ビュー共通） */
export const CalendarGridContent = React.memo(function CalendarGridContent({
  date,
  timeblocks,
  viewMode = 'day',
  dayIndex,
  allEventsForOverlapCheck,
  displayDates,
  onTimeblockClick,
  onTimeblockContextMenu,
  onEventUpdate,
  onTimeRangeSelect,
  disabledTimeblockId,
  dayDiffTimeblockIds,
  laneDisplayMode = 'both',
  externalEvents,
  className,
}: CalendarGridContentProps) {
  const { canUseProduct } = useBillingAccess();
  const { getActivityById } = useActivitiesMap();
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const { defaultDuration, timeFormat } = useUserPreferences();
  const timezone = useUserPreferences((state) => state.timezone);

  const HOUR_HEIGHT = useResponsiveHourHeight();
  const gridHeight = HOURS_PER_DAY * HOUR_HEIGHT;
  const { createRecord } = useTimeblockWriteMutations();
  const { convertGhost, dismissGhost } = useConvertGhostEvent();

  // 日付間ドラッグ（day以外のビューで使用）
  const enableCrossDayDrag = canUseProduct && viewMode !== 'day';
  const { planLaneWidthPercent, compactCards } = resolveCalendarLanePresentation(
    viewMode,
    laneDisplayMode,
  );
  const visibleTimeblocks = React.useMemo(() => {
    if (laneDisplayMode === 'both') return timeblocks;
    return timeblocks.filter((timeblock) => {
      const kind =
        timeblock.kind ??
        resolveTimeblockDestination(timeblock.endDate ?? timeblock.displayEndDate);
      return kind === laneDisplayMode;
    });
  }, [timeblocks, laneDisplayMode]);

  // ghost（#1962）。Plan レーンの領域を使うので、`laneDisplayMode === 'record'` では
  // planLaneWidthPercent が 0 になり結果的に描かれない（外部予定は実績ではない）。
  // 日の選別は生の instant + ユーザー TZ の日付キーで行い、座標とカードの時刻表示は
  // グリッドと同じ壁時計空間（toZonedTime 済み）に揃える。
  const dayExternalEvents = React.useMemo(
    () =>
      externalEvents
        ? toZonedExternalEvents(
            selectExternalEventsForDate(externalEvents, date, timezone),
            timezone,
          )
        : [],
    [externalEvents, date, timezone],
  );
  const externalEventPositions = React.useMemo(
    () =>
      calculateExternalEventLayout(dayExternalEvents, {
        day: date,
        hourHeight: HOUR_HEIGHT,
        laneWidthPercent: planLaneWidthPercent,
      }),
    [dayExternalEvents, date, HOUR_HEIGHT, planLaneWidthPercent],
  );

  const wrappedOnEventUpdate = useCallback(
    (
      eventId: string,
      updates: {
        startTime: Date;
        endTime: Date;
        resetActualTime?: boolean;
        expectedUpdatedAt?: string;
      },
    ) => {
      return onEventUpdate?.(eventId, updates);
    },
    [onEventUpdate],
  );

  const handlePlanRecord = useCallback(
    (planId: string, range: { start: Date; end: Date }) => {
      const plan = timeblocks.find(
        (timeblock) => timeblock.id === planId && timeblock.kind === 'plan',
      );
      if (!plan) return;
      createRecord.mutate(buildPlanRecordDropInput(plan, range));
    },
    [createRecord, timeblocks],
  );

  // 統合インタラクション（drag/resize/click）
  const { state, handlers } = useInteraction({
    date,
    events: visibleTimeblocks,
    ...(allEventsForOverlapCheck ? { allEventsForOverlapCheck } : {}),
    ...(displayDates ? { displayDates } : {}),
    viewMode,
    hourHeight: HOUR_HEIGHT,
    planLaneWidthPercent,
    onPlanRecord: handlePlanRecord,
    ...(onEventUpdate ? { onEventUpdate: wrappedOnEventUpdate } : {}),
    ...(onTimeblockClick ? { onEventClick: onTimeblockClick } : {}),
    ...(disabledTimeblockId != null
      ? {
          disabledPlanId: disabledTimeblockId,
          // Mobile では Inspector 開いている timeblock も resize 可（PC は Phase 1 と同じ block 維持）
          resizeDisabledPlanId: isMobile ? null : disabledTimeblockId,
        }
      : {}),
  });

  const isActive = state.mode !== 'idle';
  const isDragging = state.mode === 'dragging';
  const isResizing = state.mode === 'resizing';

  // Step 8: 2レーン座標（plan=左/record=右）。timeblocks は既に kind 付き CalendarDisplayEvent。
  const twoLaneStyles = React.useMemo(
    () =>
      calculateTwoLaneStylesForCalendarEvents(visibleTimeblocks, HOUR_HEIGHT, planLaneWidthPercent),
    [visibleTimeblocks, HOUR_HEIGHT, planLaneWidthPercent],
  );

  // ドラッグゴースト描画コールバック
  const renderGhost = useCallback(
    ({
      timeblockId,
      previewTime,
    }: {
      timeblockId: string;
      previewTime: { start: Date; end: Date };
    }) => {
      const timeblock = visibleTimeblocks.find((e) => e.id === timeblockId);
      if (!timeblock) return null;
      const previewTimeblock = buildDragPreviewTimeblock(timeblock, previewTime);
      const activity = timeblock.activityId ? getActivityById(timeblock.activityId) : null;
      const ghostHeight = Math.max(twoLaneStyles[timeblockId]?.height ?? 20, isMobile ? 40 : 20);
      const sourceKind =
        timeblock.kind ??
        resolveTimeblockDestination(timeblock.endDate ?? timeblock.displayEndDate);
      const targetLane = useCalendarDragStore.getState().targetLane ?? sourceKind;
      const previewKind = isPlanRecordDrop(sourceKind, targetLane) ? 'record' : sourceKind;
      // #2250: ゴーストの幅も表示レイヤーと同じ動的判定に揃える。相手レーンに
      // previewTime と重なる timeblock が無ければフル幅（境界の無いカラムへ「掴んだ瞬間
      // 幅が縮む」ような不整合な見た目を出さない）。
      const counterpartKind = previewKind === 'plan' ? 'record' : 'plan';
      const hasGhostCounterpart = hasLaneCounterpart(
        visibleTimeblocks.filter((candidate) => {
          if (candidate.id === timeblock.id) return false;
          const kind =
            candidate.kind ??
            resolveTimeblockDestination(candidate.endDate ?? candidate.displayEndDate);
          return kind === counterpartKind;
        }),
        previewTime.start,
        previewTime.end,
      );
      const position = !hasGhostCounterpart
        ? { top: 0, left: 0, width: 100, height: ghostHeight }
        : previewKind === 'plan'
          ? { top: 0, left: 0, width: planLaneWidthPercent, height: ghostHeight }
          : {
              top: 0,
              left: planLaneWidthPercent,
              width: 100 - planLaneWidthPercent,
              height: ghostHeight,
            };
      const sharedProps = {
        position,
        activityName: activity?.name ?? null,
        activityColor: activity?.color ?? null,
        activityIcon: activity?.icon ?? null,
        activityCategoryId: activity?.categoryId ?? null,
        compact: compactCards,
        timeFormat,
        interactive: false,
        showDayDiffMarker: dayDiffTimeblockIds?.has(timeblock.id) ?? false,
        className: 'shadow-card',
      } as const;

      if (previewKind === 'plan') {
        return (
          <PlanLaneCard
            {...sharedProps}
            event={calendarEventToPlanEvent(
              previewTimeblock,
              allEventsForOverlapCheck ?? timeblocks,
            )}
          />
        );
      }

      const recordPreview =
        sourceKind === 'plan'
          ? {
              ...previewTimeblock,
              kind: 'record' as const,
            }
          : previewTimeblock;

      return <RecordLaneCard {...sharedProps} event={calendarEventToRecordEvent(recordPreview)} />;
    },
    [
      timeblocks,
      visibleTimeblocks,
      allEventsForOverlapCheck,
      twoLaneStyles,
      getActivityById,
      isMobile,
      planLaneWidthPercent,
      compactCards,
      dayDiffTimeblockIds,
      timeFormat,
    ],
  );

  // 時間グリッド
  const timeGrid = React.useMemo(
    () =>
      Array.from({ length: 24 }, (_, hour) => (
        <div
          key={hour}
          // E2E が「この時間帯」へ touch を落とす足場（handler div の子孫である必要がある）
          data-calendar-hour={hour}
          className={`relative ${hour < 23 ? 'border-border-subtle border-b' : ''}`}
          style={{ height: HOUR_HEIGHT }}
        />
      )),
    [HOUR_HEIGHT],
  );

  return (
    <div
      className={cn('relative flex-1 overflow-visible', enableCrossDayDrag && 'h-full', className)}
      data-calendar-grid
      data-calendar-day-index={dayIndex}
    >
      {/* CalendarDragSelection: グリッド選択 + カスタム droppable */}
      <CalendarDragSelection
        date={date}
        dayIndex={dayIndex}
        className={cn('absolute inset-0', enableCrossDayDrag && 'z-10')}
        onTimeRangeSelect={onTimeRangeSelect}
        disabled={isActive || !canUseProduct}
        plans={allEventsForOverlapCheck ?? timeblocks}
        defaultDuration={defaultDuration}
        timeFormat={timeFormat}
      >
        <div className="absolute inset-0" style={{ height: gridHeight }}>
          {timeGrid}
        </div>
      </CalendarDragSelection>

      {/* タイムブロック表示エリア。この absolute + z-20 が stacking context の境界で、
          内側の zIndex（grid.constants.ts の Z_INDEX: 10-40）はグローバルな
          z-index トークン（z-dropdown: 50 等）と数値空間が別になる。意図的な分離 */}
      <div className="pointer-events-none absolute inset-0 z-20" style={{ height: gridHeight }}>
        {/* ghost はここで最初に描く。新しい z-index を作らず、後の兄弟（plan / record カード）が
            DOM 順で上に塗られることで重ね順を担保する */}
        {dayExternalEvents.map((event) => {
          const position = externalEventPositions[event.id];
          if (!position) return null;

          return (
            <ExternalEventCard
              key={event.id}
              event={event}
              position={position}
              timeFormat={timeFormat}
              compact={compactCards}
              onConvert={canUseProduct ? () => convertGhost(event) : undefined}
              onDismiss={canUseProduct ? () => dismissGhost(event) : undefined}
            />
          );
        })}
        {visibleTimeblocks.map((timeblock) => {
          const position = twoLaneStyles[timeblock.id];
          if (!position) return null;

          return (
            <TwoLaneTimeblockRenderer
              key={timeblock.id}
              timeblock={timeblock}
              position={position}
              allEvents={allEventsForOverlapCheck ?? timeblocks}
              isDragging={isDragging}
              isResizing={isResizing}
              interactionState={state}
              dayIndex={dayIndex}
              enableCrossDayDrag={enableCrossDayDrag}
              showDayDiffMarker={dayDiffTimeblockIds?.has(timeblock.id) ?? false}
              compactCards={compactCards}
              timeFormat={timeFormat}
              onTimeblockClick={onTimeblockClick}
              onTimeblockContextMenu={onTimeblockContextMenu}
              onPointerDown={(...args) => {
                if (canUseProduct) handlers.handlePointerDown(...args);
              }}
              onTouchStart={(...args) => {
                if (canUseProduct) handlers.handleTouchStart(...args);
              }}
              onResizeStart={(...args) => {
                if (canUseProduct) handlers.handleResizeStart(...args);
              }}
            />
          );
        })}

        <DragSelectionHighlight
          hourHeight={HOUR_HEIGHT}
          dayTimeblocks={allEventsForOverlapCheck ?? timeblocks}
          {...(enableCrossDayDrag ? { date } : {})}
        />
      </div>

      {/* React Portal ゴースト（DOM clone廃止） */}
      <GhostRenderer state={state} renderGhost={renderGhost} timeFormat={timeFormat} />
    </div>
  );
});
