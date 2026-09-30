'use client';

/**
 * カレンダードラッグ選択コンポーネント
 *
 * - 全ビュー共通のドラッグ選択動作を提供
 * - ドラッグ操作で時間範囲選択、ダブルクリックでプラン作成
 * - ドロップゾーンは CalendarDropZone に委譲
 */

import { cn } from '@dayopt/components';

import { useResponsiveHourHeight } from '../../hooks/useResponsiveHourHeight';
import { CalendarDropZone } from '../CalendarDropZone';
import { DragSelectionPreview } from './DragSelectionPreview';
import type { CalendarDragSelectionProps } from './types';
import { useDragSelection } from './useDragSelection';

/** カレンダー列のドラッグ選択・ダブルクリックによる時間範囲選択コンポーネント */
export const CalendarDragSelection = ({
  date,
  dayIndex,
  className,
  onTimeRangeSelect,
  onDoubleClick,
  children,
  disabled = false,
  plans = [],
  defaultDuration,
  timeFormat,
}: CalendarDragSelectionProps) => {
  const hourHeight = useResponsiveHourHeight();

  const {
    selection,
    showSelectionPreview,
    isOverlapping,
    containerRef,
    handleMouseDown,
    handleDoubleClick,
    handleTouchStart,
    formatTime,
  } = useDragSelection({
    date,
    dayIndex,
    disabled,
    onTimeRangeSelect,
    onDoubleClick,
    plans,
    hourHeight,
    defaultDuration,
    timeFormat,
  });

  return (
    <CalendarDropZone
      date={date}
      dayIndex={dayIndex ?? 0}
      className={cn(className)}
      containerRef={containerRef as React.MutableRefObject<HTMLDivElement | null>}
    >
      {/* イベントハンドラ層 */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- グリッドをなぞって時間帯を選ぶポインタ専用の面。キーボードからの新規作成はサイドバーの「+」とアクティビティ行が担う */}
      <div
        className="absolute inset-0"
        onMouseDown={(e) => {
          handleMouseDown(e);
        }}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {children}
      </div>

      {/* ドラッグ選択範囲の表示 - 5px以上ドラッグした場合のみ表示 */}
      {showSelectionPreview && selection && (
        <DragSelectionPreview
          selection={selection}
          date={date}
          formatTime={formatTime}
          isOverlapping={isOverlapping}
          hourHeight={hourHeight}
          allDayEvents={plans}
        />
      )}
    </CalendarDropZone>
  );
};
