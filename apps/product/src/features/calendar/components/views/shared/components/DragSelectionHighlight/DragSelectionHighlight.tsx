'use client';

/**
 * ドラッグ選択のハイライト
 *
 * カレンダーグリッド上でドラッグ確定後に、選択範囲をカードとして描画する。
 * アクティビティ選択と作成は Inspector の作成モード（InlineCreatePanel）が担うため、
 * ここはグリッド上の見た目とリサイズ / long-press 移動だけを持つ。
 *
 * リサイズ / long-press 移動は inline-selection-gestures に分離している。
 */

import { useEffect, useRef } from 'react';

import { isSameDay } from 'date-fns';
import { useTranslations } from 'next-intl';

import { ActivityIcon, getCategoryColorClasses } from '@/features/activities';
import {
  resolveTimeblockDestination,
  resolveTimeblockKindChoice,
  useTimeblockInspectorStore,
} from '@/features/timeblock';
import { formatTimeString, getDateKey } from '@/lib/date';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { cn } from '@dayopt/components';

import { MIN_TIMEBLOCK_DURATION_MINUTES } from '../../../../../domain/precision';
import { useHapticFeedback } from '../../../../../hooks/accessibility/useHapticFeedback';
import {
  computeRemainingDayMinutes,
  formatRemainingDuration,
  planRangesFromCalendarEvents,
} from '../../../../../lib/remaining-day-minutes';
import {
  DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  hasLaneCounterpart,
} from '../../../../../lib/two-lane-layout';
import { useInlineCreateStore } from '../../../../../stores/useInlineCreateStore';
import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

import { useInlineCreate } from '../../../../create/useInlineCreate';
import { Z_INDEX } from '../../constants/grid.constants';
import { ConflictOverlay } from '../ConflictOverlay';
import {
  createBodyPointerDownHandler,
  createResizeStartHandler,
} from './inline-selection-gestures';

/** DragSelectionHighlight コンポーネントのプロパティ */
interface DragSelectionHighlightProps {
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

/** ドラッグ選択の範囲をグリッド上にカードとして描き、リサイズ / 移動を受け付ける */
export function DragSelectionHighlight({
  hourHeight,
  date,
  dayEntries,
}: DragSelectionHighlightProps) {
  const pendingSelection = useInlineCreateStore.use.pendingSelection();
  const clearPendingSelection = useInlineCreateStore.use.clearPendingSelection();
  const updateSelectionTimes = useInlineCreateStore.use.updateSelectionTimes();
  const isCreateMode = useTimeblockInspectorStore((state) => state.createMode);
  // 作成パネルでホバー中のアクティビティ。色と名前をハイライトへ先出しする
  const hoveredActivity = useInlineCreateStore.use.hoveredActivity();
  const timezone = useUserPreferences((s) => s.timezone);
  const tCalendar = useTranslations('calendar');
  const tEntry = useTranslations('timeblock');
  const { tap, impact } = useHapticFeedback();

  const highlightRef = useRef<HTMLDivElement>(null);

  // 競合判定は作成パネルと同じロジックを使う（どちらも store の pendingSelection を見る）
  const { hasConflict } = useInlineCreate();

  // 作成パネルが閉じた（＝破棄された）らハイライトも消す。作成成功時は
  // useInlineCreate 側が先に clearPendingSelection するので二重呼び出しにならない
  useEffect(() => {
    if (isCreateMode) return;
    if (!pendingSelection) return;
    clearPendingSelection();
  }, [isCreateMode, pendingSelection, clearPendingSelection]);

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
  // 既定は end_at 判定。過去スロットだけタブで Plan / Record を選び直せる。
  const { kind: destination } = resolveTimeblockKindChoice(
    convertFromTimezone(selectionEndLocal, timezone),
    pendingSelection.kind,
  );
  const isPlan = destination === 'plan';

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

  // #2096: 予定を置く瞬間だけ、その日の残り時間を静かに示す。
  // 記録の選択・重なり表示中・compact（40px 未満）では出さない。
  // dayEntries は範囲全体の未フィルタ一覧なので activity filter の影響を受けない。
  // pendingSelection.date は壁時計 Date なので getDateKey に timezone を渡さない（#2017 同型）。
  const remainingMinutes =
    isPlan && selectionHeight >= 40 && dayEntries !== undefined
      ? computeRemainingDayMinutes({
          plans: planRangesFromCalendarEvents(dayEntries),
          dateKey: getDateKey(pendingSelection.date),
          timezone,
          selectionMinutes: endMinutes - startMinutes,
        })
      : null;

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
        // 作成パネルと組で動く。掴んで伸ばしてもパネルを閉じない（DockedInspectorPanel）
        data-inspector-keep-open
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
              {/*
                一覧と同じマーカーを出す。カテゴリーに icon が無くても色ドットへ
                フォールバックさせる（icon の有無で出し分けると、色だけ反映されて
                アイコンが出ない状態になる。2026-09-07 User 指摘）。
                未分類は継承する色が無いので、一覧と同じくテキストだけにする
              */}
              {hoveredActivity?.color != null && (
                <ActivityIcon
                  icon={hoveredActivity.icon}
                  color={hoveredActivity.color}
                  size="sm"
                  className="shrink-0"
                />
              )}
              {/*
                「予定」「記録」の文言はブロック内には出さない（種別はタブと枠線 /
                塗りつぶしの見た目だけで示す。2026-09-07 User 指摘）。選ぶ前は時刻だけ、
                選んだ後は名前だけを出す
              */}
              <span className="truncate font-medium">
                {hoveredActivity ? displayName : <span className="tabular-nums">{timeLabel}</span>}
              </span>
            </div>
          ) : (
            <>
              <div className="flex min-h-0 items-start justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1">
                  {hoveredActivity?.color != null && (
                    <ActivityIcon
                      icon={hoveredActivity.icon}
                      color={hoveredActivity.color}
                      size="sm"
                      className="shrink-0"
                    />
                  )}
                  <span className="truncate font-medium">{displayName}</span>
                </div>
              </div>
              <span className="text-muted-foreground truncate tabular-nums">{timeLabel}</span>
              {remainingMinutes !== null && (
                <span
                  data-remaining-day-minutes={remainingMinutes}
                  className="text-muted-foreground truncate tabular-nums"
                >
                  {tCalendar('timeblock.preview.remaining', {
                    duration: formatRemainingDuration(remainingMinutes),
                  })}
                </span>
              )}
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
    </>
  );
}
