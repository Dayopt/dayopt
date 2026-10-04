'use client';

import { useTranslations } from 'next-intl';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import {
  cn,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@dayopt/components';

import {
  ANIMATED_WIDTH_PANEL_TRANSITION_CLASS,
  ANIMATED_WIDTH_PANEL_TRANSITION_MS,
  AnimatedWidthPanel,
} from '@/components/shell/AnimatedWidthPanel';
import { AppHeader } from '@/components/shell/AppHeader';
import type { NavigationDirection } from '@/components/ui/navigation/DateNavigator';
import { DateNavigator } from '@/components/ui/navigation/DateNavigator';
import type { UserSettings } from '@/features/calendar/stores/userSettings';
import { useSwipeGesture } from '@/lib/hooks/useSwipeGesture';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import type { CalendarViewType } from '../../types/calendar.types';

import { DateRangeDisplay } from './Header/DateRangeDisplay';
import { MobileCalendarHeader } from './Header/MobileCalendarHeader';
import { ViewSwitcher } from './Header/ViewSwitcher';

const SIDE_RAIL_DEFAULT_WIDTH = 256;
const SIDE_RAIL_MIN_WIDTH = 256;
const SIDE_RAIL_MAX_WIDTH = 560;
const SIDE_RAIL_RESIZE_STEP = 32;
const CALENDAR_MIN_CONTENT_WIDTH = 768;
const SIDE_RAIL_SPACE_RECOVERY_SETTLE_MS = ANIMATED_WIDTH_PANEL_TRANSITION_MS + 40;

type SideRailSpaceRecoveryPhase =
  'idle' | 'suppressing' | 'suppressed' | 'restoring-inline' | 'restoring-sheet';

/** CalendarLayout コンポーネントのプロパティ */
interface CalendarLayoutProps {
  children: React.ReactNode;
  className?: string | undefined;

  // Header props
  viewType: CalendarViewType;
  currentDate: Date;
  onNavigate: (direction: NavigationDirection) => void;
  onViewChange: (view: CalendarViewType) => void;

  // Date selection for mini calendar
  selectedDate?: Date | undefined;
  onDateSelect?: ((date: Date) => void) | undefined;

  // Display range for mini calendar highlight
  displayRange?:
    | {
        start: Date;
        end: Date;
      }
    | undefined;

  // Prefetch callback (hover/touch on nav buttons)
  onPrefetch?: ((direction: NavigationDirection) => void) | undefined;

  // Settings persistence callback
  onSettingsChange?: ((settings: Partial<UserSettings>) => void) | undefined;

  // Header slots
  leftSlot?: React.ReactNode | undefined;
  rightSlot?: React.ReactNode | undefined;

  /**
   * デスクトップヘッダーの中身を差し替える（#2567 の「型として保存」中）。
   * `AppHeader` はこの component が 1 つだけ描く — 呼び出し側が独自の header を
   * 足すと 1 画面 2 header になるため、差し替えは中身だけを受け取る形にしている。
   */
  headerReplacement?: React.ReactNode | undefined;
  /** ViewSwitcher の「この並びを型として保存」。渡さなければ項目が出ない */
  onSaveAsTemplate?: (() => void) | undefined;
  /** 保存できる並びが無い日で項目を無効化する */
  saveAsTemplateDisabled?: boolean | undefined;

  // Side rail
  sideRail?: React.ReactNode | undefined;
  mobileSideRail?: React.ReactNode | undefined;
  mobileSideRailPresentation?: 'rail' | 'sheet' | undefined;
  sideRailOpen?: boolean | undefined;
  onSideRailOpenChange?: ((open: boolean) => void) | undefined;
  sideRailTitle?: string | undefined;
  sideRailDescription?: string | undefined;
  sideRailResizeLabel?: string | undefined;
  recoverableSidebarWidth?: number | undefined;
  onSideRailSpaceRecoveryChange?: ((recovering: boolean) => void) | undefined;
}

/**
 * カレンダー最上位レイアウトコンポーネント
 * ヘッダーとメインコンテンツを管理
 * モバイルでは左右スワイプで期間移動が可能
 */
export const CalendarLayout = memo<CalendarLayoutProps>(
  ({
    children,
    className,

    // Header
    viewType,
    currentDate,
    onNavigate,
    onViewChange,

    // Date selection for mini calendar
    onDateSelect,
    displayRange,

    // Prefetch
    onPrefetch,

    // Settings persistence
    onSettingsChange,

    // Header slots
    leftSlot,
    rightSlot,
    headerReplacement,
    onSaveAsTemplate,
    saveAsTemplateDisabled,

    // Side rail
    sideRail,
    mobileSideRail,
    mobileSideRailPresentation = 'rail',
    sideRailOpen = false,
    onSideRailOpenChange,
    sideRailTitle,
    sideRailDescription,
    sideRailResizeLabel,
    recoverableSidebarWidth = 0,
    onSideRailSpaceRecoveryChange,
  }) => {
    const t = useTranslations('calendar');
    const showWeekNumbers = useUserPreferences((s) => s.showWeekNumbers);
    const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);
    const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
    const [sideRailWidth, setSideRailWidth] = useState(SIDE_RAIL_DEFAULT_WIDTH);
    const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
    const [sideRailSpaceRecoveryPhase, setSideRailSpaceRecoveryPhase] =
      useState<SideRailSpaceRecoveryPhase>('idle');
    const [sideRailResizing, setSideRailResizing] = useState(false);
    const finishSideRailResizeRef = useRef<(() => void) | null>(null);
    const layoutRef = useRef<HTMLDivElement | null>(null);
    const sidebarSuppressionAppliedRef = useRef(false);
    const sideRailSpaceRecoveryChangeRef = useRef(onSideRailSpaceRecoveryChange);

    // ナビゲーション方向 + キーの追跡（スライドアニメーション用）
    const [slide, setSlide] = useState<{ key: number; direction: 'prev' | 'next' | null }>({
      key: 0,
      direction: null,
    });

    // onNavigateをラップして方向を記録
    const handleNavigate = useCallback(
      (direction: NavigationDirection) => {
        if (direction === 'prev' || direction === 'next') {
          setSlide((prev) => ({ key: prev.key + 1, direction }));
        }
        onNavigate(direction);
      },
      [onNavigate],
    );

    // スワイプで前後の期間に移動
    const handleSwipeLeft = useCallback(() => {
      handleNavigate('next');
    }, [handleNavigate]);

    const handleSwipeRight = useCallback(() => {
      handleNavigate('prev');
    }, [handleNavigate]);

    // タッチイベントのみで動作（タッチイベントが発生 = タッチデバイス）
    const { handlers, ref } = useSwipeGesture(handleSwipeLeft, handleSwipeRight);

    useEffect(() => {
      const element = layoutRef.current;
      if (!element) return;

      const updateLayoutWidth = () => {
        setLayoutWidth(element.getBoundingClientRect().width);
      };
      updateLayoutWidth();

      const resizeObserver = new ResizeObserver((entries) => {
        const [entry] = entries;
        setLayoutWidth(entry?.contentRect.width ?? element.getBoundingClientRect().width);
      });
      resizeObserver.observe(element);

      return () => resizeObserver.disconnect();
    }, []);

    const slideClass =
      slide.direction === 'next'
        ? 'calendar-slide-next'
        : slide.direction === 'prev'
          ? 'calendar-slide-prev'
          : '';
    const desktopSideRailRequested = Boolean(sideRail && sideRailOpen && !isMobile);
    const layoutWidthWithoutSidebarSuppression =
      sideRailSpaceRecoveryPhase === 'suppressed' && layoutWidth !== null
        ? Math.max(0, layoutWidth - recoverableSidebarWidth)
        : layoutWidth;
    const sideRailMaxWidth = resolveSideRailMaxWidth({
      layoutWidth: layoutWidthWithoutSidebarSuppression,
      recoverableWidth: onSideRailSpaceRecoveryChange ? recoverableSidebarWidth : 0,
      minContentWidth: CALENDAR_MIN_CONTENT_WIDTH,
    });
    const effectiveSideRailWidth = Math.min(sideRailWidth, sideRailMaxWidth);
    const desktopSideRailNeedsSpace =
      desktopSideRailRequested &&
      shouldUseSideRailSheet({
        layoutWidth: layoutWidthWithoutSidebarSuppression,
        sideRailWidth: effectiveSideRailWidth,
        minContentWidth: CALENDAR_MIN_CONTENT_WIDTH,
      });
    const desktopSideRailCanRecover =
      Boolean(onSideRailSpaceRecoveryChange) &&
      canRecoverSideRailSpace({
        layoutWidth: layoutWidthWithoutSidebarSuppression,
        sideRailWidth: effectiveSideRailWidth,
        recoverableWidth: recoverableSidebarWidth,
        minContentWidth: CALENDAR_MIN_CONTENT_WIDTH,
      });
    const desktopSideRailSheet = desktopSideRailRequested
      ? sideRailSpaceRecoveryPhase === 'restoring-sheet'
        ? true
        : sideRailSpaceRecoveryPhase === 'suppressing' ||
            sideRailSpaceRecoveryPhase === 'restoring-inline'
          ? false
          : desktopSideRailNeedsSpace && !desktopSideRailCanRecover
      : false;
    const desktopSideRailOpen = desktopSideRailRequested && !desktopSideRailSheet;
    useEffect(() => {
      if (!desktopSideRailOpen) finishSideRailResizeRef.current?.();
    }, [desktopSideRailOpen]);
    useEffect(() => () => finishSideRailResizeRef.current?.(), []);

    const contentStyle = {
      marginRight: desktopSideRailOpen ? effectiveSideRailWidth : 0,
    } satisfies React.CSSProperties;
    const resolvedSideRailTitle = sideRailTitle ?? t('title');
    const resolvedSideRailDescription = sideRailDescription ?? t('meta.description');
    const resolvedSideRailResizeLabel = sideRailResizeLabel ?? t('panel.resizeLabel');
    const sheetSideRail = isMobile
      ? mobileSideRail
      : desktopSideRailSheet
        ? (mobileSideRail ?? sideRail)
        : null;
    const sheetSideRailOpen = Boolean(sheetSideRail && sideRailOpen);
    const sheetSideRailIsSheet = desktopSideRailSheet || mobileSideRailPresentation === 'sheet';

    useEffect(() => {
      if (onSideRailSpaceRecoveryChange) {
        sideRailSpaceRecoveryChangeRef.current = onSideRailSpaceRecoveryChange;
      }
    }, [onSideRailSpaceRecoveryChange]);

    useEffect(() => {
      setSideRailWidth((width) => Math.min(width, sideRailMaxWidth));
    }, [sideRailMaxWidth]);

    useEffect(() => {
      if (sideRailSpaceRecoveryPhase === 'idle') {
        if (!desktopSideRailNeedsSpace || !desktopSideRailCanRecover) return;

        sidebarSuppressionAppliedRef.current = true;
        setSideRailSpaceRecoveryPhase('suppressing');
        onSideRailSpaceRecoveryChange?.(true);
        return;
      }

      if (sideRailSpaceRecoveryPhase === 'suppressing') {
        if (desktopSideRailRequested && onSideRailSpaceRecoveryChange) return;

        sidebarSuppressionAppliedRef.current = false;
        setSideRailSpaceRecoveryPhase('restoring-inline');
        sideRailSpaceRecoveryChangeRef.current?.(false);
        return;
      }

      if (sideRailSpaceRecoveryPhase !== 'suppressed') return;
      if (desktopSideRailRequested && desktopSideRailNeedsSpace && desktopSideRailCanRecover) {
        return;
      }

      sidebarSuppressionAppliedRef.current = false;
      setSideRailSpaceRecoveryPhase(
        desktopSideRailRequested && desktopSideRailNeedsSpace
          ? 'restoring-sheet'
          : 'restoring-inline',
      );
      sideRailSpaceRecoveryChangeRef.current?.(false);
    }, [
      desktopSideRailCanRecover,
      desktopSideRailNeedsSpace,
      desktopSideRailRequested,
      onSideRailSpaceRecoveryChange,
      sideRailSpaceRecoveryPhase,
    ]);

    useEffect(() => {
      if (sideRailSpaceRecoveryPhase === 'idle' || sideRailSpaceRecoveryPhase === 'suppressed') {
        return;
      }

      const timeout = window.setTimeout(() => {
        setSideRailSpaceRecoveryPhase(
          sideRailSpaceRecoveryPhase === 'suppressing' ? 'suppressed' : 'idle',
        );
      }, SIDE_RAIL_SPACE_RECOVERY_SETTLE_MS);
      return () => window.clearTimeout(timeout);
    }, [sideRailSpaceRecoveryPhase]);

    useEffect(
      () => () => {
        if (!sidebarSuppressionAppliedRef.current) return;

        sidebarSuppressionAppliedRef.current = false;
        sideRailSpaceRecoveryChangeRef.current?.(false);
      },
      [],
    );

    const handleSideRailResizeStart = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;

        event.preventDefault();

        finishSideRailResizeRef.current?.();

        const startX = event.clientX;
        const startWidth = sideRailWidth;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        setSideRailResizing(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const handlePointerMove = (moveEvent: PointerEvent) => {
          setSideRailWidth(
            clampSideRailWidth(startWidth - (moveEvent.clientX - startX), sideRailMaxWidth),
          );
        };
        const handlePointerUp = () => {
          setSideRailResizing(false);
          document.body.style.cursor = previousCursor;
          document.body.style.userSelect = previousUserSelect;
          window.removeEventListener('pointermove', handlePointerMove);
          window.removeEventListener('pointerup', handlePointerUp);
          window.removeEventListener('pointercancel', handlePointerUp);
          finishSideRailResizeRef.current = null;
        };

        finishSideRailResizeRef.current = handlePointerUp;
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp, { once: true });
        window.addEventListener('pointercancel', handlePointerUp, { once: true });
      },
      [sideRailMaxWidth, sideRailWidth],
    );

    const handleSideRailResizeKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setSideRailWidth((width) =>
            clampSideRailWidth(width + SIDE_RAIL_RESIZE_STEP, sideRailMaxWidth),
          );
          return;
        }

        if (event.key === 'ArrowRight') {
          event.preventDefault();
          setSideRailWidth((width) =>
            clampSideRailWidth(width - SIDE_RAIL_RESIZE_STEP, sideRailMaxWidth),
          );
          return;
        }

        if (event.key === 'Home') {
          event.preventDefault();
          setSideRailWidth(SIDE_RAIL_MIN_WIDTH);
          return;
        }

        if (event.key === 'End') {
          event.preventDefault();
          setSideRailWidth(sideRailMaxWidth);
        }
      },
      [sideRailMaxWidth],
    );

    return (
      <div
        ref={layoutRef}
        className={cn('calendar-layout relative flex h-full flex-col overflow-hidden', className)}
      >
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            !sideRailResizing && ANIMATED_WIDTH_PANEL_TRANSITION_CLASS,
          )}
          style={contentStyle}
        >
          {/* スクリーンリーダー用のページタイトル */}
          <h1 className="sr-only">{t('title')}</h1>

          {/* モバイル: インライン展開ミニカレンダー */}
          <MobileCalendarHeader
            currentDate={currentDate}
            onNavigate={handleNavigate}
            onPrefetch={onPrefetch}
            onDateSelect={onDateSelect}
            rightSlot={rightSlot}
          />

          {/* デスクトップ: ナビゲーション行。下の日付ヘッダー行（CalendarDateHeader）と
              背景を揃え、間に余白・境界線を挟まない — 2 行を「1 つの太いヘッダー」として
              視覚的に一体化する（#2233-2 案B。境界線は日付ヘッダー行の下端 1 本だけに絞る） */}
          <div className="bg-background hidden md:block">
            <AppHeader leftSlot={leftSlot} rightSlot={rightSlot}>
              {headerReplacement ?? (
                <div className="flex items-center gap-2">
                  <DateRangeDisplay
                    date={currentDate}
                    viewType={viewType}
                    showWeekNumber={showWeekNumbers}
                    weekStartsOn={weekStartsOn}
                    clickable={false}
                    displayRange={displayRange}
                  />
                  <DateNavigator
                    onNavigate={handleNavigate}
                    onPrefetch={onPrefetch}
                    arrowSize="md"
                  />
                  <ViewSwitcher
                    className="ml-2"
                    currentView={viewType}
                    onChange={(view) => onViewChange(view as CalendarViewType)}
                    onSettingsChange={onSettingsChange}
                    onSaveAsTemplate={onSaveAsTemplate}
                    saveAsTemplateDisabled={saveAsTemplateDisabled}
                  />
                </div>
              )}
            </AppHeader>
          </div>

          {/* カレンダーコンテンツ（スワイプ対応） */}
          <div
            ref={ref as React.RefObject<HTMLDivElement>}
            data-calendar-main
            className="flex min-h-0 flex-1 flex-col"
            onTouchStart={handlers.onTouchStart}
            onTouchMove={handlers.onTouchMove}
            onTouchEnd={handlers.onTouchEnd}
          >
            <div key={slide.key} className={cn('flex min-h-0 flex-1 flex-row', slideClass)}>
              <div className="flex min-w-0 flex-1 flex-col">{children}</div>
            </div>
          </div>
        </div>

        <AnimatedWidthPanel
          open={desktopSideRailOpen}
          width={effectiveSideRailWidth}
          side="right"
          disableTransition={sideRailResizing}
          className="absolute top-0 right-0 bottom-0 hidden md:flex"
          innerClassName="border-border-subtle bg-background flex h-full border-l"
        >
          {sideRail}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA の window splitter パターン。フォーカス可能な separator に aria-valuenow と onKeyDown を持たせるのが規定の形で、ルールが separator を一律に非 interactive として扱うための誤検出 */}
          <div
            role="separator"
            aria-label={resolvedSideRailResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={SIDE_RAIL_MIN_WIDTH}
            aria-valuemax={sideRailMaxWidth}
            aria-valuenow={effectiveSideRailWidth}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 同上。splitter は Tab で到達できる必要がある
            tabIndex={0}
            className="hover:bg-state-hover focus-visible:outline-ring absolute inset-y-0 left-0 w-2 -translate-x-1 cursor-col-resize transition-colors duration-150 focus-visible:outline-2"
            onPointerDown={handleSideRailResizeStart}
            onKeyDown={handleSideRailResizeKeyDown}
          />
        </AnimatedWidthPanel>

        {sheetSideRail ? (
          <Drawer
            open={sheetSideRailOpen}
            handleOnly
            {...(onSideRailOpenChange ? { onOpenChange: onSideRailOpenChange } : {})}
          >
            <DrawerContent
              className={cn('gap-0 overflow-hidden p-0', !sheetSideRailIsSheet && 'h-3/4')}
            >
              <DrawerHeader className="sr-only">
                <DrawerTitle>{resolvedSideRailTitle}</DrawerTitle>
                <DrawerDescription>{resolvedSideRailDescription}</DrawerDescription>
              </DrawerHeader>
              <div className={cn('min-h-0 overflow-hidden', !sheetSideRailIsSheet && 'flex-1')}>
                {sheetSideRail}
              </div>
            </DrawerContent>
          </Drawer>
        ) : null}
      </div>
    );
  },
);

CalendarLayout.displayName = 'CalendarLayout';

function clampSideRailWidth(width: number, maxWidth = SIDE_RAIL_MAX_WIDTH): number {
  return Math.min(maxWidth, Math.max(SIDE_RAIL_MIN_WIDTH, width));
}

export function resolveSideRailMaxWidth({
  layoutWidth,
  recoverableWidth,
  minContentWidth,
}: {
  layoutWidth: number | null;
  recoverableWidth: number;
  minContentWidth: number;
}): number {
  if (layoutWidth === null) return SIDE_RAIL_MAX_WIDTH;

  return clampSideRailWidth(layoutWidth + recoverableWidth - minContentWidth);
}

export function shouldUseSideRailSheet({
  layoutWidth,
  sideRailWidth,
  minContentWidth,
}: {
  layoutWidth: number | null;
  sideRailWidth: number;
  minContentWidth: number;
}): boolean {
  if (layoutWidth === null) return false;
  return layoutWidth - sideRailWidth < minContentWidth;
}

export function canRecoverSideRailSpace({
  layoutWidth,
  sideRailWidth,
  recoverableWidth,
  minContentWidth,
}: {
  layoutWidth: number | null;
  sideRailWidth: number;
  recoverableWidth: number;
  minContentWidth: number;
}): boolean {
  if (layoutWidth === null) return false;
  if (recoverableWidth <= 0) return false;
  return layoutWidth + recoverableWidth - sideRailWidth >= minContentWidth;
}
