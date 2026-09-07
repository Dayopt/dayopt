'use client';

/**
 * インラインアクティビティパレット
 *
 * カレンダーグリッド上でドラッグ確定後に表示される。
 * 選択範囲のハイライトをグリッド上に描画し、
 * ActivityQuickSelector（Drawer/Dialog）でアクティビティ選択 → エントリ作成。
 *
 * entry 作成・競合判定は useInlineActivityPaletteCreation、
 * リサイズ / long-press 移動は inline-selection-gestures に分離している。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { format, isSameDay } from 'date-fns';
import { enUS, ja } from 'date-fns/locale';
import { useLocale, useTranslations } from 'next-intl';

import {
  ActivityIcon,
  ActivityQuickSelector,
  getCategoryColorClasses,
} from '@/features/activities';
import { resolveTimeblockDestination } from '@/features/timeblock';
import { formatTimeString } from '@/lib/date';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useShellStore } from '@/lib/stores/useShellStore';
import { cn } from '@dayopt/components';

import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../../../../../domain/precision';
import { useHapticFeedback } from '../../../../../hooks/accessibility/useHapticFeedback';
import {
  DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  hasLaneCounterpart,
} from '../../../../../lib/two-lane-layout';
import { useInlineCreateStore } from '../../../../../stores/useInlineCreateStore';
import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

import { Z_INDEX } from '../../constants/grid.constants';
import { ConflictOverlay } from '../ConflictOverlay';
import {
  createBodyPointerDownHandler,
  createResizeStartHandler,
} from './inline-selection-gestures';
import { useInlineActivityPaletteCreation } from './useInlineActivityPaletteCreation';

/** InlineActivityPalette コンポーネントのプロパティ */
interface InlineActivityPaletteProps {
  /** 1時間あたりの高さ（px） */
  hourHeight: number;
  /** このカラムの日付（複数日ビューで対象カラムのみ表示するため） */
  date?: Date | undefined;
  /**
   * 相手レーンとの重複判定に使う、その日の全 entry（plan+record 両方）。
   * 未指定時は counterpart 無し扱いにはせず、常に split 幅（既存挙動）を保つ。
   */
  dayEntries?: CalendarDisplayEvent[] | undefined;
}

/** ドラッグ選択後にカレンダーグリッド上でアクティビティを選んでエントリ作成するコンポーネント */
export function InlineActivityPalette({
  hourHeight,
  date,
  dayEntries,
}: InlineActivityPaletteProps) {
  const pendingSelection = useInlineCreateStore.use.pendingSelection();
  const clearPendingSelection = useInlineCreateStore.use.clearPendingSelection();
  const updateSelectionTimes = useInlineCreateStore.use.updateSelectionTimes();
  const timezone = useUserPreferences((s) => s.timezone);
  const locale = useLocale();
  const tCalendar = useTranslations('calendar');
  const tEntry = useTranslations('timeblock');
  const { tap, impact } = useHapticFeedback();

  const highlightRef = useRef<HTMLDivElement>(null);

  const { hoveredActivity, handleActivityHover, handleCreate, handleCreateAndSelect, hasConflict } =
    useInlineActivityPaletteCreation();

  // selector の open は pendingSelection と分離する。
  // 「+」で modal に遷移する時は selector を閉じつつ pendingSelection を保持する必要がある
  // (open={!!pendingSelection} だと selector が閉じず modal と nest してしまう)。
  const [waitingForModal, setWaitingForModal] = useState(false);
  const activeSheetType = useShellStore((s) => s.activeSheet?.type ?? null);
  const isActivityCreateModalOpen = activeSheetType === 'activityCreate';

  // 派生 state: pending あり && modal が前にも後にもいない時だけ open
  const selectorOpen = !!pendingSelection && !isActivityCreateModalOpen && !waitingForModal;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      queueMicrotask(() => {
        if (useShellStore.getState().activeSheet?.type === 'activityCreate') {
          // modal 遷移中: pendingSelection を保持し、selector を非表示にする flag を立てる
          setWaitingForModal(true);
        } else {
          // 通常 dismiss: pendingSelection を解放
          clearPendingSelection();
        }
      });
    },
    [clearPendingSelection],
  );

  // modal close 検知: activeSheet が activityCreate から離れたら waitingForModal を解除する。
  // 外部 store (Zustand) の変化に追随する subscribe 相当のため setState を許可する。
  useEffect(() => {
    if (!waitingForModal) return;
    if (isActivityCreateModalOpen) return;
    queueMicrotask(() => setWaitingForModal(false));
  }, [waitingForModal, isActivityCreateModalOpen]);

  // pending を modal-pending 状態で抱えている間、unmount または waitingForModal の解除で
  // 必ず pending を解放する (calendar 離脱で stale selection が残らないように)。
  // 成功 path は handleCreate が先に clearPendingSelection を呼ぶため idempotent。
  useEffect(() => {
    if (!waitingForModal) return;
    return () => clearPendingSelection();
  }, [waitingForModal, clearPendingSelection]);

  const timeFormat = useUserPreferences((s) => s.timeFormat);

  // 日付が指定されている場合、対象日と一致するカラムのみ表示
  if (!pendingSelection) return null;
  if (date && !isSameDay(date, pendingSelection.date)) return null;

  const { startHour, startMinute, endHour, endMinute } = pendingSelection;

  // 選択範囲のピクセル計算
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  const selectionTop = startMinutes * (hourHeight / 60);
  const selectionHeight = (endMinutes - startMinutes) * (hourHeight / 60);

  // 時間ラベル + 合計時間
  const timeLabel = `${formatTimeString(startHour, startMinute, timeFormat)} – ${formatTimeString(endHour, endMinute, timeFormat)}`;

  // ピッカーヘッダー用の日付+時間ラベル（例: "3/30 (日) 14:00 – 15:30"）
  const dateFnsLocale = locale === 'ja' ? ja : enUS;
  const datePattern = locale === 'ja' ? 'M/d (E)' : 'E, MMM d';
  const pickerTimeLabel = `${format(pendingSelection.date, datePattern, { locale: dateFnsLocale })} ${timeLabel}`;

  const selectionStartLocal = new Date(
    pendingSelection.date.getFullYear(),
    pendingSelection.date.getMonth(),
    pendingSelection.date.getDate(),
    startHour,
    startMinute,
  );
  const selectionEndLocal = new Date(
    pendingSelection.date.getFullYear(),
    pendingSelection.date.getMonth(),
    pendingSelection.date.getDate(),
    endHour,
    endMinute,
  );
  const destination = resolveTimeblockDestination(convertFromTimezone(selectionEndLocal, timezone));
  const isPlan = destination === 'plan';
  const destinationLabel = tCalendar(`timeblock.preview.${destination}`);
  const pickerContextLabel = `${destinationLabel} · ${pickerTimeLabel}`;

  // #2250: 相手レーンに重なる entry が無ければフル幅にする（表示層・選択プレビューと
  // 同じ判定）。selectionStartLocal/EndLocal は displayStartDate/displayEndDate と
  // 同じ wall-clock 座標系（timezone 変換前）で構築しているため、そのまま比較できる。
  const counterpartKind = isPlan ? 'record' : 'plan';
  const hasCounterpart =
    dayEntries === undefined
      ? true
      : hasLaneCounterpart(
          dayEntries.filter((event) => {
            const eventKind =
              event.kind ?? resolveTimeblockDestination(event.endDate ?? event.displayEndDate);
            return eventKind === counterpartKind;
          }),
          selectionStartLocal,
          selectionEndLocal,
        );
  const laneLeft = !hasCounterpart ? 0 : isPlan ? 0 : DEFAULT_PLAN_LANE_WIDTH_PERCENT;
  const laneWidth = !hasCounterpart
    ? 100
    : isPlan
      ? DEFAULT_PLAN_LANE_WIDTH_PERCENT
      : 100 - DEFAULT_PLAN_LANE_WIDTH_PERCENT;

  // ホバー中アクティビティが継承する色を解決
  const hoveredColorClasses = hoveredActivity
    ? getCategoryColorClasses(hoveredActivity.color)
    : null;
  const planBorderClass = hoveredColorClasses?.border ?? 'border-border';
  const recordSurfaceClass = hoveredColorClasses?.tint ?? 'bg-card';
  const displayName = hoveredActivity?.name ?? tCalendar('activitySelector.title');

  const handleResizeStart = createResizeStartHandler({
    hourHeight,
    startMinutes,
    endMinutes,
    updateSelectionTimes,
    tap,
  });

  const handleBodyPointerDown = createBodyPointerDownHandler({
    hourHeight,
    startMinutes,
    endMinutes,
    updateSelectionTimes,
    tap,
    impact,
  });

  return (
    <>
      {/* 選択範囲ハイライト（カレンダーグリッド上） */}
      <div
        data-activity-palette
        className="pointer-events-none absolute right-0 left-0"
        style={{ zIndex: Z_INDEX.POPOVER }}
      >
        <div
          ref={highlightRef}
          className={cn(
            'animate-in fade-in-0 text-foreground pointer-events-auto absolute flex flex-col gap-1 overflow-hidden rounded-lg px-2 py-2 text-xs transition-colors duration-150 motion-reduce:animate-none',
            isPlan ? cn('border-2 bg-transparent', planBorderClass) : recordSurfaceClass,
          )}
          style={{
            top: selectionTop,
            left: `${laneLeft}%`,
            width: `calc(${laneWidth}% - 4px)`,
            height: selectionHeight,
            touchAction: 'none',
          }}
          onPointerDown={handleBodyPointerDown}
        >
          {hasConflict ? (
            <ConflictOverlay
              message={tEntry('errors.timeOverlap')}
              timeLabel={timeLabel}
              compact={selectionHeight < 40}
              className="absolute inset-0"
            />
          ) : selectionHeight < 40 ? (
            <div className="flex min-w-0 items-center gap-1">
              {hoveredActivity?.icon && (
                <ActivityIcon
                  icon={hoveredActivity.icon}
                  color={hoveredActivity.color}
                  size="sm"
                  className="shrink-0"
                />
              )}
              <span className="truncate font-medium">
                {hoveredActivity ? displayName : destinationLabel}
                {!hoveredActivity && (
                  <>
                    {' · '}
                    <span className="tabular-nums">{timeLabel}</span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <>
              <div className="flex min-h-0 items-start justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1">
                  {hoveredActivity?.icon && (
                    <ActivityIcon
                      icon={hoveredActivity.icon}
                      color={hoveredActivity.color}
                      size="sm"
                      className="shrink-0"
                    />
                  )}
                  <span className="truncate font-medium">{displayName}</span>
                </div>
                <span className="text-muted-foreground shrink-0">{destinationLabel}</span>
              </div>
              <span className="text-muted-foreground truncate tabular-nums">{timeLabel}</span>
            </>
          )}
          {/* 下端リサイズ横棒は非表示統一。実際のリサイズは slider が担保。 */}
          <span
            aria-hidden
            className="bg-muted-foreground pointer-events-none absolute bottom-0 left-1/2 hidden h-1 w-8 -translate-x-1/2 rounded-full"
            style={{ zIndex: 1 }}
          />
          {/* 下端 invisible resize handle (44px touch target) */}
          <div
            role="slider"
            tabIndex={0}
            aria-label={tCalendar('timeblock.adjustEndTime')}
            aria-orientation="vertical"
            aria-valuenow={endMinutes - startMinutes}
            aria-valuemin={MIN_TIMEBLOCK_DURATION_MINUTES}
            aria-valuemax={24 * 60}
            className="pointer-events-auto absolute right-0 left-0 cursor-ns-resize"
            style={{
              height: '44px',
              bottom: '-40px',
              zIndex: 2,
              touchAction: 'none',
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleResizeStart(event.clientY);
            }}
          />
        </div>
      </div>

      {/* アクティビティ選択パネル */}
      <ActivityQuickSelector
        open={selectorOpen}
        onOpenChange={handleOpenChange}
        onSelect={handleCreate}
        onCreateAndSelect={handleCreateAndSelect}
        onActivityHover={handleActivityHover}
        anchorRef={highlightRef}
        timeLabel={pickerContextLabel}
      />
    </>
  );
}
