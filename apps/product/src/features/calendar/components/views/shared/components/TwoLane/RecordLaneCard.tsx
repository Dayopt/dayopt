/**
 * Record レーン用カード（overview.md §4: 塗りカード、視覚的な主役）。
 *
 * `TimeblockCard.tsx` のトークン使用を踏襲するが、DnD・overlay 計算・gap クリック
 * 導線は Step 6 の対象のため持ち込まない（read 側専用の軽量プレゼンテーショナル
 * コンポーネント）。差分は `DiffBadge`（±0 は非表示）、予定外の記録は
 * 静かなマーカーのみ（二値ラベルは使わない、copywriting準拠）。
 */
'use client';

import type React from 'react';

import { useTranslations } from 'next-intl';

import { ActivityIcon, getCategoryColorClasses } from '@/features/activities';
import type { RecordEvent } from '@/features/timeblock';
import { formatTimeRange } from '@/lib/date';
import type { TimeFormat } from '@/lib/time';
import { cn } from '@dayopt/components';

import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';
import { DayDiffMarker } from './DayDiffMarker';
import { DiffBadge } from './DiffBadge';

interface RecordLaneCardProps {
  event: RecordEvent;
  position: TwoLanePosition;
  /** Calendar カードの表示名。title ではなくアクティビティを source of truth とする。 */
  activityName: string | null;
  activityColor?: string | null | undefined;
  activityIcon?: string | null | undefined;
  /**
   * 所属カテゴリー ID。null = 未分類（activity は実在するが継承元カテゴリーが無い）。
   * 「アクティビティなし」（activityName === null）とは別概念 — #2162 §4-6。
   */
  activityCategoryId?: string | null | undefined;
  className?: string | undefined;
  /** Inspector で選択中か（強調表示） */
  isActive?: boolean | undefined;
  /** auto_migrated など RLS で不変な record。ドラッグ・リサイズを禁止する */
  disableDrag?: boolean | undefined;
  /** Compare panel に表示中の entry であることを示す */
  showDayDiffMarker?: boolean | undefined;
  /** 複数日表示の狭い列では secondary detail と余白を減らす */
  compact?: boolean | undefined;
  /** ユーザー設定に基づく時刻表記 */
  timeFormat?: TimeFormat | undefined;
  /** false の場合はdrag ghostなど表示専用として操作・focus対象から外す */
  interactive?: boolean | undefined;
  onClick?: ((event: RecordEvent, e: React.MouseEvent) => void) | undefined;
  onContextMenu?: ((event: RecordEvent, e: React.MouseEvent) => void) | undefined;
  onPointerDown?: ((event: RecordEvent, e: React.MouseEvent) => void) | undefined;
  onTouchStart?: ((event: RecordEvent, e: React.TouchEvent) => void) | undefined;
  onResizeStart?:
    ((event: RecordEvent, e: React.MouseEvent | React.TouchEvent) => void) | undefined;
  /** ドラッグ中の opacity / リサイズ中の zIndex など、呼び出し側から上書きしたい style */
  styleOverride?: React.CSSProperties | undefined;
}

const MIN_HEIGHT = 20;
const DETAIL_HEIGHT_THRESHOLD = 40;
const RESIZE_HANDLE_HEIGHT = 20;

export function RecordLaneCard({
  event,
  position,
  activityName,
  activityColor = null,
  activityIcon = null,
  activityCategoryId = null,
  className,
  isActive = false,
  disableDrag = false,
  showDayDiffMarker = false,
  compact = false,
  timeFormat = '24h',
  interactive = true,
  onClick,
  onContextMenu,
  onPointerDown,
  onTouchStart,
  onResizeStart,
  styleOverride,
}: RecordLaneCardProps) {
  const t = useTranslations();
  // activityName は「アクティビティが実在するか」の source of truth（Activity.name は
  // 非nullのため、実在すれば必ず文字列になる）。activityColor/activityIcon の null 判定は、
  // 未分類（継承元カテゴリーが無い）と区別できないため使わない。
  const hasActivity = activityName !== null;
  // 未分類 = activity は実在するが所属カテゴリーが無い。「アクティビティなし」とは別概念。
  const isUncategorized = hasActivity && activityCategoryId === null;
  // 色は activity が実在する限り解決する（未分類でも DEFAULT_CATEGORY_COLOR を適用）。
  // アクティビティなしの時だけ中立トークンの塗りに落とす。
  const colorClasses = hasActivity ? getCategoryColorClasses(activityColor) : null;
  const displayName = activityName ?? t('calendar.filter.noActivity');
  const isUnplanned = event.planId == null;
  const hasDiff = event.diffMinutes != null && event.diffMinutes !== 0;
  const showDetails = !compact && position.height >= DETAIL_HEIGHT_THRESHOLD;
  const canDrag = interactive && !disableDrag && Boolean(onPointerDown);
  return (
    <div
      data-record-lane-card
      data-record-planned={!isUnplanned}
      data-entry-block={interactive ? 'true' : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      aria-label={interactive ? displayName : undefined}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        'absolute flex flex-col gap-1 overflow-hidden rounded-lg py-1 text-xs',
        interactive ? 'pointer-events-auto' : 'pointer-events-none',
        compact ? 'px-1' : 'px-2',
        colorClasses?.tint ?? 'bg-card',
        'text-foreground',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        isActive && 'ring-ring ring-2',
        showDayDiffMarker && 'pr-8',
        interactive && 'cursor-pointer',
        className,
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}%`,
        width: `calc(${position.width}% - 4px)`,
        height: `${Math.max(position.height, MIN_HEIGHT)}px`,
        ...styleOverride,
      }}
      onClick={interactive ? (e) => onClick?.(event, e) : undefined}
      onContextMenu={interactive ? (e) => onContextMenu?.(event, e) : undefined}
      onMouseDown={
        interactive
          ? (e) => {
              if (e.button === 0 && canDrag) onPointerDown?.(event, e);
            }
          : undefined
      }
      onTouchStart={
        interactive
          ? (e) => {
              if (canDrag) onTouchStart?.(event, e);
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.(event, e as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-1">
        <p className="flex min-h-0 items-start gap-1 truncate font-medium">
          {/* 未分類（activity はあるがカテゴリー無所属）は icon 領域自体を出さない
              （空アイコン・フォールバック絵文字も出さない、#2235）。「アクティビティなし」
              のみ neutral マーカーへフォールバックする */}
          {isUncategorized ? null : (
            <ActivityIcon
              icon={activityIcon}
              color={activityColor}
              size="sm"
              className="shrink-0"
              neutral={!hasActivity}
            />
          )}
          <span className="truncate">{displayName}</span>
        </p>
        {hasDiff && !compact && <DiffBadge diffMinutes={event.diffMinutes ?? 0} />}
      </div>
      {showDetails && (
        <p className="text-muted-foreground truncate">
          {formatTimeRange(event.displayStartDate, event.displayEndDate, timeFormat)}
        </p>
      )}
      {showDayDiffMarker && <DayDiffMarker />}
      {canDrag && onResizeStart && (
        <div
          role="slider"
          tabIndex={-1}
          aria-label={t('calendar.timeblock.adjustEndTime')}
          aria-orientation="vertical"
          aria-valuenow={position.height}
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={1440}
          className="absolute right-0 bottom-0 left-0 cursor-ns-resize"
          style={{ height: RESIZE_HANDLE_HEIGHT }}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onResizeStart(event, e);
          }}
          onTouchStart={(e) => {
            e.stopPropagation();
            onResizeStart(event, e);
          }}
        />
      )}
    </div>
  );
}
