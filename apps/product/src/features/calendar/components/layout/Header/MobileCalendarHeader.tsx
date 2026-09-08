'use client';

import { format, getWeek, isSameMonth } from 'date-fns';
import { enUS, ja } from 'date-fns/locale';
import { BarChart3, ChevronDown, ChevronUp, Redo2, Search, Undo2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AppHeader } from '@/components/shell/AppHeader';
import { isPastDayInTimezone, isTodayInTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useShellStore } from '@/lib/stores/useShellStore';
import { Button, cn } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';

import type { NavigationDirection } from '@/components/ui/navigation/DateNavigator';

import { MobileMonthGrid } from '@/components/ui/navigation/MobileMonthGrid';
import { MobileYearStrip } from '@/components/ui/navigation/MobileYearStrip';
import { formatCalendarDateParam } from '../../../lib/date-param';

interface MobileCalendarHeaderProps {
  currentDate: Date;
  onNavigate: (direction: NavigationDirection) => void;
  /** ホバー/タッチ時にナビゲーション先のデータを事前取得する */
  onPrefetch?: ((direction: NavigationDirection) => void) | undefined;
  onDateSelect?: ((date: Date) => void) | undefined;
  rightSlot?: ReactNode | undefined;
  className?: string | undefined;
  defaultExpanded?: boolean | undefined;
}

/**
 * モバイル専用カレンダーヘッダー
 *
 * AppHeader + インライン展開月グリッド。
 * ヘッダータップで月グリッドをインライン展開し、タイムラインを押し下げる。
 * Google Calendar のモバイルUIを参考にした設計。
 */
export const MobileCalendarHeader = memo<MobileCalendarHeaderProps>(
  ({
    currentDate,
    onNavigate,
    onPrefetch,
    onDateSelect,
    rightSlot,
    className,
    defaultExpanded,
  }) => {
    const t = useTranslations('calendar');
    const locale = useLocale();
    const dateFnsLocale = locale === 'ja' ? ja : enUS;
    const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false);
    const openTimeblockSearch = useShellStore.use.openTimeblockSearch();
    // 外側タップで閉じる（#2297）。ヘッダー+パネル全体を containerRef で囲み、
    // isExpanded の間だけ document レベルの pointerdown を監視する
    const containerRef = useRef<HTMLDivElement>(null);

    // viewMonth: グリッドスワイプで独立して変化する表示月
    const [viewMonth, setViewMonth] = useState(() => currentDate);

    // render-time sync: currentDateの月が変わったらviewMonthも追従
    const [prevCurrentDate, setPrevCurrentDate] = useState(currentDate);
    if (!isSameMonth(currentDate, prevCurrentDate)) {
      setPrevCurrentDate(currentDate);
      setViewMonth(currentDate);
    } else if (currentDate !== prevCurrentDate) {
      setPrevCurrentDate(currentDate);
    }

    // ヘッダー: 月部分・日番号・接尾辞を分離して今日バッジ + 週数を1行に統合
    const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);
    const showWeekNumbers = useUserPreferences((s) => s.showWeekNumbers);
    const timezone = useUserPreferences((s) => s.timezone);
    const monthPart = format(currentDate, locale === 'ja' ? 'M月' : 'MMM ', {
      locale: dateFnsLocale,
    });
    const dayNumber = format(currentDate, 'd');
    const daySuffix = locale === 'ja' ? '日' : '';
    const weekdayShort = format(currentDate, 'EEE', { locale: dateFnsLocale });
    const today = isTodayInTimezone(currentDate, timezone);
    // 過去日を見ている: Redo（時間を進めて今日へ戻る）。未来日を見ている: Undo
    // （時間を戻して今日へ戻る）。today の時はボタン自体を非表示にする（#2302）
    const isPast = !today && isPastDayInTimezone(currentDate, timezone);
    const TodayIcon = isPast ? Redo2 : Undo2;
    const weekNumber = getWeek(currentDate, { weekStartsOn });

    const handleToggle = useCallback(() => {
      setIsExpanded((prev) => !prev);
    }, []);

    // 外側タップで閉じる（#2297）。isExpanded の間だけ document レベルの
    // pointerdown を監視し、containerRef の外側なら閉じる。toggle ボタン自身は
    // containerRef 内側にあるため、開閉の二重発火（閉じた直後に再度開く）は
    // 起きない
    useEffect(() => {
      if (!isExpanded) return;

      const handlePointerDown = (event: PointerEvent) => {
        if (!containerRef.current) return;
        if (!(event.target instanceof Node)) return;
        if (containerRef.current.contains(event.target)) return;
        setIsExpanded(false);
      };

      document.addEventListener('pointerdown', handlePointerDown);
      return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [isExpanded]);

    // Google Calendar準拠: 日付選択してもパネルは閉じない（Chevronタップでのみ閉じる）
    const handleDateSelect = useCallback(
      (date: Date) => {
        onDateSelect?.(date);
      },
      [onDateSelect],
    );

    // 月変更時: ローカルviewMonth更新 + メインカレンダーも連動
    const handleViewMonthChange = useCallback(
      (newMonth: Date) => {
        setViewMonth(newMonth);
        onDateSelect?.(newMonth);
      },
      [onDateSelect],
    );

    const handleTodayClick = useCallback(() => {
      onNavigate('today');
    }, [onNavigate]);

    const ChevronIcon = isExpanded ? ChevronUp : ChevronDown;

    return (
      <div
        ref={containerRef}
        className={cn('bg-background sticky top-0 z-20 md:hidden', className)}
      >
        <AppHeader
          rightSlot={
            <div className="flex h-8 items-center gap-1">
              {/* 今日を見ている時はボタン自体を非表示にする（#2302）。過去日は
                  Redo（時間を進めて戻る）、未来日は Undo（時間を戻す）を出す */}
              {!today && (
                <Button
                  variant="ghost"
                  icon
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleTodayClick}
                  onMouseEnter={() => onPrefetch?.('today')}
                  onTouchStart={() => onPrefetch?.('today')}
                  aria-label={t('actions.goToToday')}
                >
                  <TodayIcon className="size-5" />
                </Button>
              )}
              {/* フッターの BottomTabBar 廃止に伴うトグル（#2300）。現在地ではなく
                  遷移先（レポート）を示すアイコン。SidebarUtilities.tsx のテーマ
                  切り替えパターンに倣う */}
              <Button
                variant="ghost"
                icon
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                asChild
              >
                <Link
                  href={`/report?date=${formatCalendarDateParam(currentDate)}`}
                  aria-label={t('actions.openReport')}
                >
                  <BarChart3 className="size-5" />
                </Link>
              </Button>
              {rightSlot}
            </div>
          }
        >
          <button
            type="button"
            onClick={handleToggle}
            // 44px のタッチターゲット。AppHeader の行は 32px だが、はみ出す分は
            // 透明なので見た目は動かず、当たり判定だけが広がる
            className="flex min-h-11 items-center gap-1"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? t('actions.closeMiniCalendar') : t('actions.openCalendar')}
          >
            <h2 className="flex items-center gap-2 text-xl">
              <span className="flex items-center">
                <span>{monthPart}</span>
                <span
                  className={cn(
                    'flex items-center justify-center',
                    today &&
                      'bg-primary text-primary-foreground size-7 rounded-full text-base font-medium',
                  )}
                >
                  {dayNumber}
                </span>
                {daySuffix ? <span>{daySuffix}</span> : null}
              </span>
              <span className="text-sm font-normal">{weekdayShort}</span>
              {showWeekNumbers ? (
                <span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full text-xs font-normal">
                  {weekNumber}
                </span>
              ) : null}
            </h2>
            <ChevronIcon className="text-muted-foreground size-5" />
          </button>
        </AppHeader>

        {/* インライン展開パネル — grid-rows アニメーション */}
        <div
          inert={!isExpanded}
          className={cn(
            // eslint-disable-next-line tailwindcss/no-arbitrary-value -- grid-template-rows の transition はトークンで表現不可
            'ease-standard grid transition-[grid-template-rows] duration-200',
            isExpanded ? 'grid-rows-expanded' : 'grid-rows-collapsed',
          )}
        >
          <div className="overflow-hidden">
            <div>
              <div className="px-3 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground min-h-11 w-full justify-start gap-2"
                  onClick={openTimeblockSearch}
                  aria-label={t('search.open')}
                >
                  <Search className="size-4" />
                  <span>{t('search.open')}</span>
                </Button>
              </div>

              {/* 月グリッド。
                  **`displayRange` は渡さない。** カレンダーの表示日は連続とは限らず
                  （週末非表示の複数日ビューでは `generateMultiDayDates` が土日を飛ばす）、
                  端点だけを帯にすると描いていない土日まで「表示中」と塗ってしまう。
                  帯を出すなら `viewDateRange.days` そのものを渡す形へ直してから
                  （2026-09-07 の反証レビュー指摘）。レポートの期間は常に連続なので
                  あちらは `displayRange` を使う */}
              <MobileMonthGrid
                viewMonth={viewMonth}
                selectedDate={currentDate}
                onViewMonthChange={handleViewMonthChange}
                onDateSelect={handleDateSelect}
                className="w-full"
              />

              {/* 年セレクタ — 横スクロール */}
              <MobileYearStrip
                viewMonth={viewMonth}
                onViewMonthChange={handleViewMonthChange}
                className=""
              />
            </div>
          </div>
        </div>
      </div>
    );
  },
);

MobileCalendarHeader.displayName = 'MobileCalendarHeader';
