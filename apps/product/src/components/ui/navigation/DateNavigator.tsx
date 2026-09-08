'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn, HoverTooltip } from '@dayopt/components';
import { useTranslations } from 'next-intl';

export type NavigationDirection = 'prev' | 'next' | 'today';

interface DateNavigatorProps {
  onNavigate: (direction: NavigationDirection) => void;
  /** ホバー/タッチ時にナビゲーション先のデータを事前取得する */
  onPrefetch?: ((direction: NavigationDirection) => void) | undefined;
  todayLabel?: string | undefined;
  showTodayButton?: boolean | undefined;
  showArrows?: boolean | undefined;
  className?: string | undefined;
  arrowSize?: 'sm' | 'md' | 'lg' | undefined;
}

const arrowSizes = {
  sm: 'size-4',
  md: 'size-4',
  lg: 'size-5',
};

const navButtonBase =
  'flex h-full items-center justify-center transition-colors hover:bg-state-hover';

/**
 * 日付ナビゲーション
 * 前後移動と今日への移動を提供
 * Google Calendar風のグループ化ボタンバー
 *
 * **デザイン仕様**:
 * - ボタン高さ: 32px（8pxグリッド準拠）
 * - アイコン: 16px（size-4）
 * - 共通ボーダーで囲み、内部はdividerで区切る
 */
export const DateNavigator = ({
  onNavigate,
  onPrefetch,
  todayLabel,
  showTodayButton = true,
  showArrows = true,
  className,
  arrowSize = 'md',
}: DateNavigatorProps) => {
  const t = useTranslations();

  return (
    <div
      className={cn(
        'divide-border border-border inline-flex h-8 items-center divide-x overflow-hidden rounded-lg border',
        className,
      )}
    >
      {showArrows && (
        <HoverTooltip content={t('common.previous')} side="bottom" wrapperClassName="h-full">
          <button
            type="button"
            onClick={() => onNavigate('prev')}
            onMouseEnter={() => onPrefetch?.('prev')}
            onTouchStart={() => onPrefetch?.('prev')}
            className={cn(navButtonBase, 'text-muted-foreground w-8')}
            aria-label={t('common.previous')}
          >
            <ChevronLeft className={arrowSizes[arrowSize]} />
          </button>
        </HoverTooltip>
      )}

      {showTodayButton && (
        <HoverTooltip
          content={t('calendar.actions.goToToday')}
          side="bottom"
          wrapperClassName="h-full"
        >
          <button
            type="button"
            onClick={() => onNavigate('today')}
            onMouseEnter={() => onPrefetch?.('today')}
            onTouchStart={() => onPrefetch?.('today')}
            className={cn(navButtonBase, 'px-4 text-sm')}
          >
            {todayLabel ?? t('common.time.today')}
          </button>
        </HoverTooltip>
      )}

      {showArrows && (
        <HoverTooltip content={t('common.next')} side="bottom" wrapperClassName="h-full">
          <button
            type="button"
            onClick={() => onNavigate('next')}
            onMouseEnter={() => onPrefetch?.('next')}
            onTouchStart={() => onPrefetch?.('next')}
            className={cn(navButtonBase, 'text-muted-foreground w-8')}
            aria-label={t('common.next')}
          >
            <ChevronRight className={arrowSizes[arrowSize]} />
          </button>
        </HoverTooltip>
      )}
    </div>
  );
};

/**
 * コンパクトな日付ナビゲーション（矢印のみ）
 */
export const CompactDateNavigator = ({
  onNavigate,
  className,
  arrowSize = 'sm',
}: Pick<DateNavigatorProps, 'onNavigate' | 'className' | 'arrowSize'>) => {
  return (
    <DateNavigator
      onNavigate={onNavigate}
      showTodayButton={false}
      showArrows={true}
      className={className}
      arrowSize={arrowSize}
    />
  );
};
