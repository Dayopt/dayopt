'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import { usePathname } from 'next/navigation';

import { useCalendarNavigationStore } from '@/features/calendar/stores/useCalendarNavigationStore';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { isValidCalendarViewToken } from '@/lib/calendar-view-tokens';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';

import { getNextPeriod, getPreviousPeriod } from '../../domain/view-range';
import { formatCalendarDateParam, parseCalendarDateParam } from '../../lib/date-param';
import { resolveWorkspaceTab } from '../../lib/route-utils';
import type { CalendarViewType } from '../../types/calendar.types';

// ── カレンダーページ判定・初期値計算（旧 useCalendarProviderProps） ──

/**
 * トークン集合は proxy.ts（Edge runtime）と共有する `@/lib/calendar-view-tokens` が正本。
 * 旧実装は正規表現を独自に持ち proxy.ts / calendar-page-params.ts と三重実装だった
 * （`AGENTS.md §PR / git 運用` §同型指摘の打ち切り に従い単一定義へ統一）。
 */
function isValidViewType(view: string): view is CalendarViewType {
  return isValidCalendarViewToken(view);
}

/**
 * モバイルで提供する表示。day-only（#2299）。
 *
 * かつては week も許可していたが、モバイルでは実質 DayView にしか収束せず
 * （CalendarViewRenderer 参照）、機能していない「7日」選択肢だった。
 */
function isMobileCalendarViewSupported(view: CalendarViewType): boolean {
  return view === 'day';
}

/** SSR安全に現在の URL search から日付を読む（window.location.search は client-only） */
function readDateParamFromLocation(): Date | undefined {
  if (typeof window === 'undefined') return undefined;
  return parseCalendarDateParam(new URLSearchParams(window.location.search).get('date'));
}

/**
 * `/report` 滞在中に最後にいた calendar view を localStorage へ憶えておく。
 *
 * `/report` の URL は `view=` を持たないため（date のみ）、`/report` 上での
 * page reload は Provider を再マウントさせ、view の初期値を復元する手がかりが
 * URL に無くなる。WorkspaceTabs の「カレンダーへ戻る」リンクはこの Provider の
 * `viewType` を読んで `/calendar?view=` を組み立てるため、reload 直後にここが
 * 既定値へ落ちると、直前まで day だったのに reload 後は week へ戻ってしまう
 * （2026-08-19、calendar-navigation.spec.ts の reload 実走で検出）。
 */
const LAST_CALENDAR_VIEW_STORAGE_KEY = 'dayopt:last-calendar-view';

function readLastCalendarView(): CalendarViewType | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(LAST_CALENDAR_VIEW_STORAGE_KEY);
    return raw && isValidViewType(raw) ? raw : undefined;
  } catch {
    // localStorage 利用不可（プライベートブラウジング等）は諦めて既定値へ
    return undefined;
  }
}

function writeLastCalendarView(view: CalendarViewType): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_CALENDAR_VIEW_STORAGE_KEY, view);
  } catch {
    // 同上、書き込み失敗は無視してよい（ただの復元ヒントであり必須データではない）
  }
}

/**
 * pathname と URL searchParams からワークスペースタブ判定と初期値を計算
 *
 * `fallbackDate` は calendar / report いずれでもない workspaceTab（例: /settings）で
 * 使う initialDate のフォールバック。呼び出し側の currentDateRef を渡すことで、
 * `/report` `/settings` 滞在中に initialDate が `new Date()` へ空転し続けるのを防ぐ
 * （旧 docs/projects/_archive/workspace-shell-restructure/overview.md §6-10 B、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
 */
function resolveCalendarProps(pathname: string, fallbackDate?: Date) {
  const pathWithoutLocale = pathname.replace(/^\/(ja|en)/, '');
  const workspaceTab = resolveWorkspaceTab(pathWithoutLocale);

  if (workspaceTab === 'report') {
    const initialDate = readDateParamFromLocation() ?? fallbackDate ?? new Date();
    return {
      isCalendarPage: false as const,
      workspaceTab,
      initialDate,
      // /report の URL は view を持たないため、直前に /calendar にいた時の view を
      // localStorage から復元する（無ければ week。readLastCalendarView 参照）。
      initialView: readLastCalendarView() ?? 'week',
    };
  }

  if (workspaceTab === 'other') {
    return {
      isCalendarPage: false as const,
      workspaceTab,
      initialDate: fallbackDate ?? new Date(),
      initialView: 'week' as CalendarViewType,
    };
  }

  const viewParam =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null;
  const view: CalendarViewType = viewParam && isValidViewType(viewParam) ? viewParam : 'week';
  const initialDate = readDateParamFromLocation() ?? new Date();

  return {
    isCalendarPage: true as const,
    workspaceTab,
    initialDate,
    initialView: view,
  };
}

interface CalendarNavigationContextValue {
  currentDate: Date;
  viewType: CalendarViewType;
  /** ナビゲーション中（日付変更・ビュー切替）のトランジション状態 */
  isPending: boolean;
  navigateToDate: (date: Date, updateUrl?: boolean) => void;
  changeView: (view: CalendarViewType) => void;
  navigateRelative: (direction: 'prev' | 'next' | 'today', showWeekends?: boolean) => void;
}

const CalendarNavigationContext = createContext<CalendarNavigationContextValue | null>(null);

/**
 * カレンダーナビゲーション状態を提供するコンテキストプロバイダー
 *
 * pathname から isCalendarPage / initialDate / initialView を自動計算する。
 * 外部から useSearchParams() を渡す必要がないため、
 * 親コンポーネントの Suspense 境界を不要にする。
 */
export const CalendarNavigationProvider = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname() ?? '/';

  // pathname + window.location.search からワークスペースタブ判定と初期値を計算。
  // render 中は ref を読めない（react-hooks/refs）ため fallbackDate は渡さない —
  // 'other'（/settings 等）の initialDate が pathname 変化のたびに new Date() へ
  // 空転する点は overview.md §6-10 B も「害は無い」と明記しており、event handler
  // 側（popstate。下記）でだけ currentDateRef を使う。
  const { isCalendarPage, initialDate, initialView } = useMemo(
    () => resolveCalendarProps(pathname),
    [pathname],
  );

  // useRefで最新値を保持し、コールバックの依存配列を安定化
  const currentDateRef = useRef<Date>(initialDate);

  const [currentDate, setCurrentDate] = useState(initialDate);
  const [viewType, setViewType] = useState<CalendarViewType>(initialView);

  // モバイル判定（Day / Week以外の表示を制限するために使用）
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const isMobileRef = useRef(isMobile);

  // カレンダー再描画が重いため、日付・ビュー変更をtransitionとしてマーク
  // UIスレッドをブロックせず、ユーザー入力（スクロール等）を優先する
  const [isPending, startTransition] = useTransition();

  // useRefで最新値を保持し、コールバックの依存配列を安定化
  const viewTypeRef = useRef(viewType);
  const pathnameRef = useRef(pathname);

  // 現在のlocaleを取得（例: /ja/day -> ja）
  const locale = pathname?.split('/')[1] || 'ja';
  const localeRef = useRef(locale);

  // ref同期 + グローバルストア同期（1つのeffectに統合）
  React.useEffect(() => {
    currentDateRef.current = currentDate;
    viewTypeRef.current = viewType;
    localeRef.current = locale;
    isMobileRef.current = isMobile;
    pathnameRef.current = pathname;
    // Palette等がカレンダー表示日/ビュータイプを参照するためグローバルに同期
    useCalendarNavigationStore.getState()._syncViewedDate(currentDate);
    useCalendarNavigationStore.getState()._syncViewType(viewType);
    // /report での reload 後に復元できるよう、calendar page にいる間だけ憶えておく
    // （readLastCalendarView 参照。/report 自体の view は無関係のまま書き換えない）。
    if (isCalendarPage) {
      writeLastCalendarView(viewType);
    }
  }, [currentDate, viewType, locale, isMobile, pathname, isCalendarPage]);

  /**
   * 今いる面（calendar / report）の URL を書く。
   *
   * 旧 `writeCalendarUrl` から改名: view はカレンダー限定の概念になったため、
   * 「今いる面」ベースで書き先を分岐させる（overview.md §5-4-b）。
   * タブ判定は `pathnameRef`（usePathname() 由来）のみで行い、
   * `useSearchParams()` は使わない（§5-3 と同じ理由）。
   */
  const writeWorkspaceUrl = useCallback(
    (view: CalendarViewType, date: Date, historyMode: 'push' | 'replace') => {
      const pathWithoutLocale = pathnameRef.current.replace(/^\/(ja|en)/, '');
      const currentTab = resolveWorkspaceTab(pathWithoutLocale);

      const params = new URLSearchParams(window.location.search);
      params.set('date', formatCalendarDateParam(date));

      let newUrl: string;
      if (currentTab === 'report') {
        // range 等の既存クエリはそのまま素通しし、date だけ更新する
        newUrl = `/${localeRef.current}/report?${params.toString()}`;
      } else {
        params.set('view', view);
        newUrl = `/${localeRef.current}/calendar?${params.toString()}`;
      }

      if (historyMode === 'push') {
        window.history.pushState(null, '', newUrl);
      } else {
        window.history.replaceState(null, '', newUrl);
      }
    },
    [],
  );

  // モバイルで未対応のビュー（day 以外）が設定された場合、dayへ切替
  // （URL直アクセスやブラウザ戻る/進むで week〜7day の URL に遷移した場合のガード）
  React.useEffect(() => {
    if (isCalendarPage && isMobile && !isMobileCalendarViewSupported(viewType)) {
      startTransition(() => {
        setViewType('day');
      });
      // URLもday viewに更新
      writeWorkspaceUrl('day', currentDateRef.current, 'replace');
    }
  }, [isCalendarPage, isMobile, viewType, writeWorkspaceUrl]);

  // URL に view= が明示されていたら viewType を同期する
  // （ブラウザ戻る/進む、直接URL入力時）。
  // モバイルでは Day / Week 以外への変更を拒否（Effect A の replaceState と競合防止）
  //
  // `initialView`（[pathname] のみに依存する useMemo 由来）は使わない: Next.js の
  // クライアント遷移は pathname を search より先に確定するため、遷移直後の 1 render は
  // search にまだ view= が付いていない瞬間があり（2026-08-19 実測）、その瞬間の
  // `initialView` は既定値 'week' に丸められている。この stale な既定値を「URL の
  // 意思」として signState へ同期すると、既に正しく復元済みの viewType を破壊する。
  // **view= の不在は「意見なし」であり、既定値の主張ではない** — 明示されている時
  // だけ同期対象にする。
  React.useEffect(() => {
    if (!isCalendarPage || typeof window === 'undefined') return;
    const viewParam = new URLSearchParams(window.location.search).get('view');
    if (viewParam === null || !isValidViewType(viewParam)) return;
    if (viewParam === viewType) return;
    if (isMobileRef.current && !isMobileCalendarViewSupported(viewParam)) return;
    setViewType(viewParam);
  }, [isCalendarPage, pathname, viewType]);

  // URL由来の initialDate が変更されたら currentDate を同期
  // （ブラウザ戻る/進む、直接URL入力時）
  React.useEffect(() => {
    if (isCalendarPage && initialDate.getTime() !== currentDateRef.current.getTime()) {
      startTransition(() => {
        setCurrentDate(initialDate);
      });
    }
  }, [isCalendarPage, initialDate, startTransition]);

  React.useEffect(() => {
    const handlePopState = () => {
      const resolved = resolveCalendarProps(window.location.pathname, currentDateRef.current);
      // 'other'（/settings 等）は非対応のまま。calendar / report は両方扱う
      // （overview.md §6-10 B「popstate の早期return」対策）。
      if (resolved.workspaceTab === 'other') return;

      if (resolved.workspaceTab === 'report') {
        startTransition(() => {
          setCurrentDate(resolved.initialDate);
        });
        return;
      }

      const nextView =
        isMobileRef.current && !isMobileCalendarViewSupported(resolved.initialView)
          ? 'day'
          : resolved.initialView;

      startTransition(() => {
        setCurrentDate(resolved.initialDate);
        setViewType(nextView);
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [startTransition]);

  const navigateToDate = useCallback(
    (date: Date, updateUrl = false) => {
      startTransition(() => {
        setCurrentDate(date);
      });

      if (updateUrl) {
        // 日付変更は履歴に追加しない（replaceState）
        writeWorkspaceUrl(viewTypeRef.current, date, 'replace');
      }
    },
    [writeWorkspaceUrl],
  );

  const changeView = useCallback(
    (view: CalendarViewType) => {
      // モバイルではDayのみ許可
      if (isMobileRef.current && !isMobileCalendarViewSupported(view)) return;

      startTransition(() => {
        setViewType(view);
      });
      // pushState: 即座にURL更新、サーバーナビゲーションなし
      // Next.js App Router は pushState と統合済み（usePathname等が同期する）
      writeWorkspaceUrl(view, currentDateRef.current, 'push');
    },
    [writeWorkspaceUrl],
  );

  const navigateRelative = useCallback(
    (direction: 'prev' | 'next' | 'today', showWeekends = true) => {
      let newDate: Date;

      if (direction === 'today') {
        newDate = new Date();
      } else {
        newDate =
          direction === 'next'
            ? getNextPeriod(viewTypeRef.current, currentDateRef.current, showWeekends)
            : getPreviousPeriod(viewTypeRef.current, currentDateRef.current, showWeekends);
      }

      navigateToDate(newDate, true);
    },
    [navigateToDate],
  );

  const contextValue = useMemo(
    () => ({
      currentDate,
      viewType,
      isPending,
      navigateToDate,
      changeView,
      navigateRelative,
    }),
    [currentDate, viewType, isPending, navigateToDate, changeView, navigateRelative],
  );

  return (
    <CalendarNavigationContext.Provider value={contextValue}>
      {children}
    </CalendarNavigationContext.Provider>
  );
};

/** カレンダーナビゲーションコンテキストを取得するフック（カレンダーページ外ではnullを返す） */
export function useCalendarNavigation() {
  const context = useContext(CalendarNavigationContext);
  if (!context) {
    // カレンダーページ以外ではnullを返す
    return null;
  }
  return context;
}
