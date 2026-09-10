/**
 * 統一されたスクロール可能カレンダーレイアウト
 *
 * リファクタリング済み: ロジックは専用フックに分離
 * - useScrollableCalendar: スクロール管理・キーボードナビゲーション
 * - useCurrentTimeLine: 現在時刻線のロジック
 * - useSleepHoursLayout: グリッドレイアウト計算
 */

'use client';

import React, { useCallback, useRef } from 'react';

import { cn } from '@dayopt/components';

import { formatTimeString } from '@/lib/date';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { resolveTimeColumnWidth } from '../constants/grid.constants';
import { CurrentTimeLine } from '../grid/CurrentTimeLine';
import { TimeColumn } from '../grid/TimeColumn/TimeColumn';
import { useContainerHeight } from '../hooks/useContainerHeight';
import { useCurrentTimeLine } from '../hooks/useCurrentTimeLine';
import { useHourHeightSync, useResponsiveHourHeight } from '../hooks/useResponsiveHourHeight';
import { useScrollableCalendar } from '../hooks/useScrollableCalendar';
import { useScrollTimeblockIntoView } from '../hooks/useScrollTimeblockIntoView';
import { useSleepHoursLayout } from '../hooks/useSleepHoursLayout';
import { TimezoneOffset } from './TimezoneOffset';

/** ScrollableCalendarLayout コンポーネントのプロパティ */
interface ScrollableCalendarLayoutProps {
  children: React.ReactNode;
  className?: string | undefined;
  showTimeColumn?: boolean | undefined;
  showCurrentTime?: boolean | undefined;
  showTimezone?: boolean | undefined;
  timeColumnWidth?: number | undefined;
  onTimeClick?: ((hour: number, minute: number) => void) | undefined;
  displayDates?: Date[] | undefined;
  viewMode?: 'day' | '3day' | '5day' | 'week' | undefined;

  // スクロール機能の追加
  enableKeyboardNavigation?: boolean | undefined;
  onScrollPositionChange?: ((scrollTop: number) => void) | undefined;
}

interface CalendarDateHeaderProps {
  header: React.ReactNode;
  showTimeColumn?: boolean | undefined;
  showTimezone?: boolean | undefined;
  timeColumnWidth?: number | undefined;
  /** 週番号（表示する場合） */
  weekNumber?: number | undefined;
  className?: string | undefined;
}

/**
 * 時間列の既定メトリクス。モバイルは幅を詰めつつ、ラベルを一段小さくして
 * 左右 8px の余白が消えないようにする。12h 表記（`12:00 PM`）は 24h より広い。
 *
 * timeColumnWidth を明示指定しない呼び出し元（CalendarDateHeader /
 * ScrollableCalendarLayout 共通）が同じ値源を見るための共有 hook。片方だけ幅を
 * 変えるとヘッダーとグリッドの列がズレる。
 */
function useDefaultTimeColumnMetrics(): { width: number; dense: boolean } {
  const isMobile = useIsMobile();
  const timeFormat = useUserPreferences((s) => s.timeFormat);

  return { width: resolveTimeColumnWidth(timeFormat, isMobile), dense: isMobile };
}

/**
 * カレンダー日付ヘッダー（固定）
 */
export const CalendarDateHeader = ({
  header,
  showTimeColumn = true,
  showTimezone = true,
  timeColumnWidth,
  weekNumber,
  className,
}: CalendarDateHeaderProps) => {
  const showWeekNumbers = useUserPreferences((s) => s.showWeekNumbers);
  const defaultTimeColumn = useDefaultTimeColumnMetrics();
  const resolvedTimeColumnWidth = timeColumnWidth ?? defaultTimeColumn.width;

  // 設定がオンで週番号が渡されている場合のみ表示
  const shouldShowWeekNumber = showWeekNumbers && weekNumber != null;

  return (
    // md 以上（デスクトップ）はナビゲーション行（CalendarLayout の AppHeader）と背景・下端の
    // 境界線を共有し、2 行合わせて「1 つの太いヘッダー」に見せる（#2233-2 案B）。モバイルは
    // MobileCalendarHeader が独立したヘッダーを持つため対象外。
    // 垂直方向は items-center で中央寄せする（旧 flex-col justify-end + items-end は
    // 中身を下端の border-b に隙間なく張り付かせ、実測で上15px/下0pxの偏った余白になっていた）
    <div
      className={cn(
        'md:border-border-subtle md:bg-background flex h-8 shrink-0 items-center md:h-12 md:border-b',
        className,
      )}
    >
      {/* flex-1 が必須: 親（flex-row + items-center）は子を幅方向に stretch しないため、
          無いと中身が横方向にshrink-to-fitして左詰めになる（旧 flex-col + 暗黙の
          align-items: stretch に依存していた分の明示化） */}
      <div className="flex flex-1 items-center">
        {/* 左スペーサー（時間列と揃えるため） */}
        {showTimeColumn ? (
          <div
            className="flex h-8 shrink-0 flex-col items-center justify-center"
            style={{ width: resolvedTimeColumnWidth }}
          >
            {/* 週番号バッジ（Googleカレンダースタイル） - モバイルのみ表示 */}
            {shouldShowWeekNumber ? (
              <span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full text-xs font-normal md:hidden">
                {weekNumber}
              </span>
            ) : null}
            {/* タイムゾーン表示（PC: 常に表示、モバイル: 週番号がない場合のみ） */}
            {showTimezone ? (
              <TimezoneOffset className={cn('w-full', shouldShowWeekNumber && 'hidden md:flex')} />
            ) : null}
          </div>
        ) : null}

        {/* 各ビューが独自のヘッダーを配置するエリア */}
        <div className="flex-1">{header}</div>
      </div>
    </div>
  );
};

/**
 * スクロール可能カレンダーコンテンツ
 */
export const ScrollableCalendarLayout = ({
  children,
  className = '',
  showTimeColumn = true,
  showCurrentTime = true,
  showTimezone: _showTimezone = true,
  timeColumnWidth,
  onTimeClick,
  displayDates = [],
  viewMode = 'week',
  enableKeyboardNavigation = true,
  onScrollPositionChange,
}: ScrollableCalendarLayoutProps) => {
  const defaultTimeColumn = useDefaultTimeColumnMetrics();
  const resolvedTimeColumnWidth = timeColumnWidth ?? defaultTimeColumn.width;

  // scroll container の ref を先に確保し、実測高の観測と useScrollableCalendar 双方で共有する
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const containerHeight = useContainerHeight(scrollContainerRef);

  // hourHeight store をコンテナ実測高と同期（カレンダー内で1箇所のみ）
  useHourHeightSync(containerHeight);
  const HOUR_HEIGHT = useResponsiveHourHeight();

  // グリッドレイアウト計算（フック利用）
  const { gridHeight, hasToday } = useSleepHoursLayout({
    hourHeight: HOUR_HEIGHT,
    displayDates,
  });

  // スクロール管理・キーボードナビゲーション（フック利用、ref は上で確保したものを共有）
  const { handleKeyDown } = useScrollableCalendar({
    viewMode,
    hourHeight: HOUR_HEIGHT,
    enableKeyboardNavigation,
    onScrollPositionChange,
    containerRef: scrollContainerRef,
  });

  // Mobile + Inspector open / Tag draft open のとき、対象が Drawer に隠れないよう自動スクロール
  useScrollTimeblockIntoView({ scrollContainerRef, hourHeight: HOUR_HEIGHT });

  // 現在時刻線ロジック（フック利用）
  const { currentTime, currentTimePosition } = useCurrentTimeLine({
    hourHeight: HOUR_HEIGHT,
    showCurrentTime,
  });

  // 現在時刻のフォーマット（設定に応じて 24h/12h）
  const timeFormat = useUserPreferences((s) => s.timeFormat);
  const formattedCurrentTime = formatTimeString(
    currentTime.getHours(),
    currentTime.getMinutes(),
    timeFormat,
  );

  // グリッドクリックハンドラー
  const handleGridClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onTimeClick || !scrollContainerRef.current) return;

      const rect = scrollContainerRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top + scrollContainerRef.current.scrollTop;
      const x = e.clientX - rect.left;

      // 時間列以外の領域のクリックのみ処理
      if (showTimeColumn && x < resolvedTimeColumnWidth) return;

      // 1分単位でスナップ
      const totalMinutes = Math.max(0, Math.floor((y / HOUR_HEIGHT) * 60));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      if (hours >= 0 && hours < 24) {
        onTimeClick(hours, minutes);
      }
    },
    [onTimeClick, HOUR_HEIGHT, showTimeColumn, resolvedTimeColumnWidth, scrollContainerRef],
  );

  // 現在時刻線を表示するか判定
  const shouldShowCurrentTimeLine = showCurrentTime;

  return (
    <div
      ref={scrollContainerRef}
      className={cn('calendar-scrollbar relative min-h-0 flex-1 overflow-y-auto', className)}
      data-calendar-scroll
    >
      <div
        className="relative flex w-full"
        style={{ height: `${gridHeight}px` }}
        onClick={handleGridClick}
        onKeyDown={handleKeyDown}
        tabIndex={enableKeyboardNavigation ? 0 : -1}
        role={enableKeyboardNavigation ? 'group' : undefined}
        aria-label={enableKeyboardNavigation ? `${viewMode} view calendar` : undefined}
      >
        {/* 時間軸列 */}
        {showTimeColumn && (
          <div
            className="border-border sticky left-0 z-10 shrink-0 border-r"
            style={{ width: resolvedTimeColumnWidth }}
          >
            <div className="relative h-full overflow-hidden">
              <TimeColumn
                startHour={0}
                endHour={24}
                hourHeight={HOUR_HEIGHT}
                format={timeFormat}
                className="h-full"
                width={resolvedTimeColumnWidth}
                dense={defaultTimeColumn.dense}
              />
              {/* 現在時刻ラベル（Apple Calendar風） */}
              {shouldShowCurrentTimeLine && hasToday && (
                <div
                  className="bg-now-indicator text-now-indicator-foreground pointer-events-none absolute right-1 z-20 rounded-lg px-1 py-1 text-xs font-medium tabular-nums"
                  style={{
                    top: `${currentTimePosition}px`,
                    transform: 'translateY(-50%)',
                  }}
                  aria-hidden="true"
                >
                  {formattedCurrentTime}
                </div>
              )}
            </div>
          </div>
        )}

        {/* グリッドコンテンツエリア */}
        <div className="relative flex flex-1 flex-col">
          {/* メインコンテンツ（flex で横並びを維持） */}
          <div className="relative flex h-full">{children}</div>

          {/* 縦の区切り線 */}
          {displayDates && displayDates.length > 1 && (
            <div className="pointer-events-none absolute inset-0 z-5 flex">
              {displayDates.map((date, index) => (
                <div
                  key={date.toISOString()}
                  className={cn(
                    'flex-1',
                    index < displayDates.length - 1 && 'border-border-subtle border-r',
                  )}
                />
              ))}
            </div>
          )}

          {/* 現在時刻線 */}
          {shouldShowCurrentTimeLine && displayDates && displayDates.length > 0 ? (
            <CurrentTimeLine
              hourHeight={HOUR_HEIGHT}
              displayDates={displayDates}
              viewMode={viewMode}
              showDot={viewMode !== 'day'}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};
