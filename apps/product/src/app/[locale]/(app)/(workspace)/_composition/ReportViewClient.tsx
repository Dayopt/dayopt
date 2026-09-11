'use client';

import { CalendarDays, PanelLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';

import { useCalendarNavigation } from '@/features/calendar';
import {
  ConnectedReportDetailPanel,
  ReportBody,
  ReportFilterChipRow,
  ReportHeader,
  ReportMobileHeader,
  resolveReportRange,
  resolveZonedDayKey,
  shiftReportAnchor,
  todayReportAnchor,
  type ReportGranularity,
} from '@/features/review';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useSwipeGesture } from '@/lib/hooks/useSwipeGesture';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useShellStore } from '@/lib/stores/useShellStore';
import { Button, Skeleton } from '@dayopt/components';
import { Link, useRouter } from '@dayopt/i18n/navigation';

import { ConnectedMobileAccountButton } from '../../_shell/MobileAccountButton';
import { useReportJump } from './useReportJump';

interface ReportViewClientProps {
  granularity: ReportGranularity;
}

/**
 * ReportViewClient - `/report` の Composition Bridge
 *
 * `features/review` は同層の `features/calendar` を import できないため、期間ナビの配線
 * （`useCalendarNavigation`）とルーティング（`useRouter`）をここが担う。review 側は
 * props のコールバックで受ける。
 *
 * **表示中の日付の正本は `useCalendarNavigation().currentDate`**（`CalendarViewClient` と
 * 同じ形）。`?date=` を server component から prop で受け取ってはいけない — `navigateToDate`
 * は `history.replaceState` で URL を書くだけで Next.js の router を経由しないため、
 * server component は再描画されず prop が更新されない。prop を正本にすると `‹ ›` を押しても
 * 画面が変わらなくなる。Context は `/report` の `?date=` 読み取りと popstate 同期を
 * 既に持っている（`CalendarNavigationContext` の `resolveCalendarProps`）。
 *
 * `/report` は `hasOwnHeader` 扱い（`_shell/desktop-layout.tsx`）なので、shell が出していた
 * サイドバートグルとモバイルのアカウントボタンもここから `ReportHeader` の slot へ渡す
 * （`CalendarViewClient` が `CalendarLayout` に渡しているのと同じ形）。
 */
export function ReportViewClient({ granularity }: ReportViewClientProps) {
  const t = useTranslations();
  const navigation = useCalendarNavigation();
  const router = useRouter();
  const timezone = useUserPreferences((s) => s.timezone);
  const weekStartsOn = useUserPreferences((s) => s.weekStartsOn);
  const sidebar = useShellStore.use.sidebar();
  const toggleSidebar = useShellStore.use.toggleSidebar();
  // 器（ヘッダー・フィルタ・詳細）の選択。モバイルの shell は Sidebar も詳細 slot も持たない。
  // **判定は shell（`BaseLayoutContent`）と同じ `MEDIA_QUERIES.mobile` にする** —
  // `useIsMobile()` は「幅 かつ coarse pointer」なので、狭くしたデスクトップの窓では false に
  // なる。器だけモバイル（slot 無し）・中身だけデスクトップ（portal 先が無い）に割れると、
  // 行を押しても何も開かない面が生まれる（#2581 のクロスレビュー P2 と同じ壊れ方）
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);

  // Context は SSR では `?date=` を読めず（`window` が無い）「今日」で始まるため、
  // サーバーの HTML と client の初回描画がずれる。マウントまで骨組みを出して
  // ハイドレーション不整合を避ける（`CalendarNavigationContext` の初期値解決と同じ制約）。
  const hasMounted = useHasMounted();
  const anchorDate = formatAnchor(navigation?.currentDate);

  // 4 章からカレンダーへのジャンプ（仕様 §7）。review は router を持たない
  const jump = useReportJump({ anchorDate, granularity, weekStartsOn });

  const range = useMemo(
    () => resolveReportRange(anchorDate, granularity, timezone, weekStartsOn),
    [anchorDate, granularity, timezone, weekStartsOn],
  );

  /**
   * 期間の移動。
   *
   * `navigateRelative` は使わない（calendar の viewType 基準で動くため、レポートの粒度と
   * 食い違う）。日付は必ず `navigateToDate` 経由で書く — review が独自に history を触ると
   * `CalendarNavigationContext` が stale になり、`WorkspaceTabs` がタブ往復で古い日付を組む。
   */
  const handleNavigate = useCallback(
    (direction: 'prev' | 'next' | 'today') => {
      const nextAnchor =
        direction === 'today'
          ? todayReportAnchor(timezone)
          : shiftReportAnchor(anchorDate, granularity, direction === 'next' ? 1 : -1);

      // Context を更新すると URL（`?date=`）も書き換わり、`range` は素通しで残る。
      navigation?.navigateToDate(parseAnchorToLocalDate(nextAnchor), true);
    },
    [anchorDate, granularity, navigation, timezone],
  );

  /**
   * ミニカレンダーで日付を選んだ時。**粒度は変えず**、その日を含む期間へ移す
   * （週を見ていれば、その日の週へ）。期間の解決は `range` が anchor から素通しで
   * 行うので、ここは anchor を書くだけでよい。
   *
   * 書き込みは `handleNavigate` と同じく `navigateToDate` 経由にする。review が独自に
   * history を触ると `CalendarNavigationContext` が stale になる。
   */
  const handleDateSelect = useCallback(
    (date: Date) => {
      navigation?.navigateToDate(date, true);
    },
    [navigation],
  );

  const handleGranularityChange = useCallback(
    (next: ReportGranularity) => {
      router.push(`/report?date=${anchorDate}&range=${next}`);
    },
    [anchorDate, router],
  );

  /**
   * モバイルの左右スワイプで前後の期間へ（仕様 §8）。
   *
   * しきい値は画面幅ベースの既定（40〜80px）ではなく 55px / 縦の 1.4 倍で固定する。
   * `/report` は縦スクロールが主で、章をなぞる指が期間を飛ばすと数字が黙って入れ替わる。
   * 移動は `handleNavigate` 経由 = `navigateToDate`（`navigateRelative` はカレンダーの
   * viewType 基準なのでレポートの粒度と食い違う）。
   */
  const swipeNext = useCallback(() => handleNavigate('next'), [handleNavigate]);
  const swipePrev = useCallback(() => handleNavigate('prev'), [handleNavigate]);
  const { handlers: swipeHandlers, ref: swipeRef } = useSwipeGesture(swipeNext, swipePrev, {
    threshold: 55,
    directionRatio: 1.4,
    disabled: !isMobile,
  });

  // Sidebar は desktop 専用。閉じている時だけトグルを出す（shell の実装と同じ条件）。
  const sidebarToggle = !sidebar.open ? (
    <Button
      type="button"
      variant="ghost"
      icon
      size="sm"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
      className="hidden md:inline-flex"
    >
      <PanelLeft className="size-4" />
    </Button>
  ) : null;

  // モバイルのワークスペース切替（#2300 でフッターの BottomTabBar を置き換えたもの）。
  // 現在地ではなく遷移先（カレンダー）を示すアイコンで、日付を引き継ぐ。
  // 日付は「表示中の期間の anchor」から組む。粒度切替は pathname を変えないため
  // Context の `currentDate` だけを見ると、粒度を変えた後に古い日付を指しうる。
  const calendarHref = navigation
    ? `/calendar?view=${navigation.viewType}&date=${anchorDate}`
    : '/calendar';

  const mobileActions = (
    <div className="flex h-8 items-center gap-1 md:hidden">
      <Button
        variant="ghost"
        icon
        size="sm"
        className="text-muted-foreground hover:text-foreground"
        asChild
      >
        <Link href={calendarHref} aria-label={t('calendar.actions.openCalendar')}>
          <CalendarDays className="size-5" />
        </Link>
      </Button>
      <ConnectedMobileAccountButton />
    </div>
  );

  if (!hasMounted) {
    // 本文（`ReportBody`）と同じ枠にする。ずれると mount 後に横位置が跳ねる
    return (
      <div className="flex h-full flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-8 w-64 rounded-lg" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  // **期間の両端は `range.startAt` / `range.endAt` から取る。** bucket の粒度は
  // 週=日 / 月=週 / 年=月 と変わるので、末尾 bucket の `key` は期間の終わりではない
  // （月なら最終週の開始日、年なら `YYYY-MM` で `parseAnchorToLocalDate` が 1 日と読む）。
  // `endAt` は半開区間の終端なので 1ms 引いて、その瞬間の壁時計日を最終日にする。
  const periodStartKey = resolveZonedDayKey(range.startAt, timezone);
  const periodEndKey = resolveZonedDayKey(
    new Date(new Date(range.endAt).getTime() - 1).toISOString(),
    timezone,
  );
  const periodStart = parseAnchorToLocalDate(periodStartKey);
  const periodEnd = parseAnchorToLocalDate(periodEndKey);
  const todayAnchor = todayReportAnchor(timezone);
  // `YYYY-MM-DD` は辞書順 = 時系列なので、文字列比較で足りる
  const todayDirection =
    todayAnchor < periodStartKey ? 'future' : todayAnchor > periodEndKey ? 'past' : 'current';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isMobile ? (
        <>
          <ReportMobileHeader
            periodStart={periodStart}
            periodEnd={periodEnd}
            granularity={granularity}
            todayDirection={todayDirection}
            onNavigate={handleNavigate}
            onGranularityChange={handleGranularityChange}
            onDateSelect={handleDateSelect}
            rightSlot={mobileActions}
          />
          {/* サイドバーを持たない面のフィルタとレンズ。読み書きは同じ store */}
          <ReportFilterChipRow />
        </>
      ) : (
        <ReportHeader
          periodStart={periodStart}
          periodEnd={periodEnd}
          granularity={granularity}
          weekStartsOn={weekStartsOn}
          onNavigate={handleNavigate}
          onGranularityChange={handleGranularityChange}
          leftSlot={sidebarToggle}
          rightSlot={mobileActions}
        />
      )}

      {/* 詳細の器はここが選ぶ（デスクトップ = shell の 4 カラム目へ portal / モバイル =
          ボトムシート）。review 本体に tRPC query を持ち込まないため、ここから描く */}
      <ConnectedReportDetailPanel
        anchorDate={anchorDate}
        granularity={granularity}
        surface={isMobile ? 'sheet' : 'panel'}
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        ref={swipeRef as React.RefObject<HTMLDivElement>}
        {...swipeHandlers}
      >
        <ReportBody
          anchorDate={anchorDate}
          granularity={granularity}
          onJumpToDay={jump.onJumpToDay}
          onJumpToNextPeriod={jump.onJumpToNextPeriod}
          onJumpToRecord={jump.onJumpToRecord}
        />
      </div>
    </div>
  );
}

/**
 * `YYYY-MM-DD` を壁時計の Date として読む。
 *
 * 期間ラベルと `navigateToDate` はローカル日付の Date を期待するため、時刻としては
 * 再解釈せず年月日の成分だけを使う。
 */
function parseAnchorToLocalDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** 壁時計 Date を `YYYY-MM-DD` へ。Provider が無い場合（Storybook 等）は今日。 */
function formatAnchor(date: Date | undefined): string {
  const target = date ?? new Date();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${target.getFullYear()}-${month}-${day}`;
}
