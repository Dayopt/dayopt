/**
 * Plan レーン用カード（overview.md §4: アウトライン・淡色、控えめ）。
 *
 * `TimeblockCard.tsx` のトークン使用（タグカラー、色分けロジック）を踏襲するが、
 * DnD・overlay 計算・gap クリック導線は Step 6 の対象のため持ち込まない
 * （read 側専用の軽量プレゼンテーショナルコンポーネント）。
 */
'use client';

import type React from 'react';
import { useRef } from 'react';

import { useTranslations } from 'next-intl';

import { ActivityIcon, getCategoryColorClasses } from '@/features/activities';
import type { PlanEvent } from '@/features/timeblock';
import { formatTimeRange } from '@/lib/date';
import type { TimeFormat } from '@/lib/time';
import { cn } from '@dayopt/components';

import { DRAG_THRESHOLD_PX } from '../../../../../domain/interaction/machine-constants';
import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';
import { DayDiffMarker } from './DayDiffMarker';

interface PlanLaneCardProps {
  event: PlanEvent;
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
  /** 過去 plan などドラッグ・リサイズを禁止する場合 true */
  disableDrag?: boolean | undefined;
  /** 過去 plan などリサイズだけを禁止する場合 true */
  disableResize?: boolean | undefined;
  /** Compare panel に表示中の entry であることを示す */
  showDayDiffMarker?: boolean | undefined;
  /** 複数日表示の狭い列では secondary detail と余白を減らす */
  compact?: boolean | undefined;
  /** ユーザー設定に基づく時刻表記 */
  timeFormat?: TimeFormat | undefined;
  /** false の場合はdrag ghostなど表示専用として操作・focus対象から外す */
  interactive?: boolean | undefined;
  onClick?: ((event: PlanEvent, e: React.MouseEvent) => void) | undefined;
  onContextMenu?: ((event: PlanEvent, e: React.MouseEvent) => void) | undefined;
  onPointerDown?: ((event: PlanEvent, e: React.MouseEvent) => void) | undefined;
  onTouchStart?: ((event: PlanEvent, e: React.TouchEvent) => void) | undefined;
  onResizeStart?: ((event: PlanEvent, e: React.MouseEvent | React.TouchEvent) => void) | undefined;
  /** ドラッグ中の opacity / リサイズ中の zIndex など、呼び出し側から上書きしたい style */
  styleOverride?: React.CSSProperties | undefined;
}

const MIN_HEIGHT = 20;
const DETAIL_HEIGHT_THRESHOLD = 40;
const RESIZE_HANDLE_HEIGHT = 20;

export function PlanLaneCard({
  event,
  position,
  activityName,
  activityColor = null,
  activityIcon = null,
  activityCategoryId = null,
  className,
  isActive = false,
  disableDrag = false,
  disableResize = false,
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
}: PlanLaneCardProps) {
  const t = useTranslations();
  // activityName は「アクティビティが実在するか」の source of truth（Activity.name は
  // 非nullのため、実在すれば必ず文字列になる）。activityColor/activityIcon の null 判定は、
  // 未分類（継承元カテゴリーが無い）と区別できないため使わない。
  const hasActivity = activityName !== null;
  // 未分類 = activity は実在するが所属カテゴリーが無い。「アクティビティなし」とは別概念。
  const isUncategorized = hasActivity && activityCategoryId === null;
  // 色は activity が実在する限り解決する（未分類でも DEFAULT_CATEGORY_COLOR を適用）。
  // アクティビティなしの時だけ中立トークンの枠線に落とす。
  const colorClasses = hasActivity ? getCategoryColorClasses(activityColor) : null;
  const borderClass = colorClasses?.border ?? 'border-border';
  const displayName = activityName ?? t('calendar.filter.noActivity');

  const hasRecords = event.status === 'with-records';
  // 時刻を出すかは縦に入るかだけで決める。狭い列（compact）でも高さがあるカードから
  // 時刻が消えていて、何時のブロックか読めなかった（2026-09-07 User 指摘）
  const showDetails = position.height >= DETAIL_HEIGHT_THRESHOLD;
  const canDrag = interactive && !disableDrag && Boolean(onPointerDown);
  /**
   * クリックの届け先は 1 つにする。掴めるカードでは pointer の状態機械が「動いていない＝
   * クリック」と判断して届ける（EVENT_CLICK）ので、同じ gesture の末尾に来るブラウザの
   * click は捨てる。2 経路とも届けると開閉のトグルが打ち消し合う（2026-09-10 User 指摘）。
   *
   * 判定は mousedown / touchstart の時点で固定する。mouseup で状態機械が開いた直後に
   * click が来るため、click 時点の isActive を見ると「開いているカードの click」と誤認する。
   * 詳細を開いているカード（isActive）は状態機械が握らない（drag 無効）ので click が届ける。
   * キーボードの click は gesture を伴わないので常に届ける。動かしてから離した click
   * （drag の末尾）は状態機械が EVENT_CLICK を出さないので従来どおり届ける。
   */
  const gestureStartRef = useRef<{ x: number; y: number } | null>(null);
  const beginGesture = (x: number, y: number) => {
    gestureStartRef.current = canDrag && !isActive ? { x, y } : null;
  };
  const handleClick = (e: React.MouseEvent) => {
    const start = gestureStartRef.current;
    gestureStartRef.current = null;
    if (start) {
      const moved = Math.max(Math.abs(e.clientX - start.x), Math.abs(e.clientY - start.y));
      // 不等号は状態機械に合わせる。pointer-up.ts は `> DRAG_THRESHOLD_PX` を「動いた」と
      // 見なすので、閾値ちょうど（5px）は EVENT_CLICK が出る。ここを `<` にすると 5px の
      // 時だけ 2 経路とも届き、トグルが打ち消し合う
      if (moved <= DRAG_THRESHOLD_PX) return;
    }
    onClick?.(event, e);
  };
  return (
    <div
      data-plan-lane-card
      data-plan-status={event.status}
      data-entry-block={interactive ? 'true' : undefined}
      data-entry-id={interactive ? event.id : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      aria-label={interactive ? displayName : undefined}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        'absolute flex flex-col gap-1 overflow-hidden rounded-lg text-xs',
        interactive ? 'pointer-events-auto' : 'pointer-events-none',
        compact ? 'border px-2' : 'border-2 px-3',
        // 高さが足りないカードだけ上下を詰める（詰めないと文字が切れる）
        showDetails ? 'py-2' : 'py-1',
        borderClass,
        // 同じアクティビティで15分以上重なる記録がある予定は控えめに沈める。
        hasRecords ? 'opacity-60' : 'opacity-100',
        'border-solid',
        'text-foreground bg-transparent',
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
      onClick={interactive ? handleClick : undefined}
      onContextMenu={interactive ? (e) => onContextMenu?.(event, e) : undefined}
      onMouseDown={
        interactive
          ? (e) => {
              if (e.button !== 0 || !canDrag) return;
              beginGesture(e.clientX, e.clientY);
              onPointerDown?.(event, e);
            }
          : undefined
      }
      onTouchStart={
        interactive
          ? (e) => {
              if (!canDrag) return;
              const touch = e.touches[0];
              beginGesture(touch?.clientX ?? 0, touch?.clientY ?? 0);
              onTouchStart?.(event, e);
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
      {showDetails && (
        <p className="text-muted-foreground truncate">
          {formatTimeRange(event.displayStartDate, event.displayEndDate, timeFormat)}
        </p>
      )}
      {showDayDiffMarker && <DayDiffMarker />}
      {canDrag && !disableResize && onResizeStart && (
        <div
          // ポインター用のジェスチャー領域。キーボードではカードから Inspector の時刻入力を使う。
          // ピクセル高を時刻の slider として公開しない。
          role="presentation"
          data-resize-handle
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
