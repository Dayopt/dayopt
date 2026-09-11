'use client';

import { useCallback, useDeferredValue, useEffect, useMemo } from 'react';

import { addDays, subDays } from 'date-fns';

import { useActivities, useArchivedActivities } from '@/features/activities';
import {
  useExternalCalendarEvents,
  type ExternalCalendarEvent,
} from '@/features/external-calendar';
import { getDateKey } from '@/lib/date';
import { toTZEndISO, toTZStartISO, tzIsSameDay } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { api } from '@/lib/trpc';

import { useCalendarFilterStore } from '@/features/calendar/stores/useCalendarFilterStore';

import {
  calculateViewDateRange,
  getNextPeriod,
  getPreviousPeriod,
} from '../../../domain/view-range';
import { applyTimezoneToDisplayDates } from '../../../lib/plan-data-adapter';
import { expandRecordRowsToRecordEvents } from '../../../lib/record-event-adapter';

import type {
  CalendarDisplayEvent,
  CalendarViewType,
  ViewDateRange,
} from '../../../types/calendar.types';
import { isMultiDayView } from '../../../types/calendar.types';

interface UseCalendarDataOptions {
  viewType: CalendarViewType;
  currentDate: Date;
  showWeekends: boolean;
}

interface UseCalendarDataResult {
  viewDateRange: ViewDateRange;
  filteredEvents: CalendarDisplayEvent[];
  allCalendarEvents: CalendarDisplayEvent[];
  /**
   * 外部カレンダーの未変換予定（ghost）。読み取り専用で、タグフィルタの対象にしない
   * （外部予定にタグは無い）。取得に失敗しても空配列になるだけで、calendar 全体は落とさない。
   */
  externalEvents: ExternalCalendarEvent[];
  /** time model 取得エラー */
  timeblocksError: unknown | null;
  /** time model 取得中かどうか（初回のみ true） */
  isTimeblocksLoading: boolean;
  /** バックグラウンド再取得中も含めて取得中かどうか */
  isTimeblocksFetching: boolean;
  /** エントリ取得を手動で再試行する */
  refetchTimeblocks: () => Promise<unknown>;
  /** ナビゲーション方向に対応する日付範囲を事前取得する */
  prefetchDirection: (direction: 'prev' | 'next' | 'today') => void;
  /** ビュー切り替え先の日付範囲を即座に事前取得する */
  prefetchForView: (newViewType: CalendarViewType) => void;
}

/**
 * カレンダーデータ取得・変換フック
 *
 * ビュータイプと日付から plan / record を取得し、既存カレンダー表示型に射影して返す
 */
export function useCalendarData({
  viewType,
  currentDate,
  showWeekends,
}: UseCalendarDataOptions): UseCalendarDataResult {
  // 週の開始日設定とタイムゾーンを取得
  const weekStartsOn = useUserPreferences((state) => state.weekStartsOn);
  const timezone = useUserPreferences((state) => state.timezone);

  // ビューに応じた期間計算（週の開始日設定を反映）
  const viewDateRange = useMemo(() => {
    return calculateViewDateRange(viewType, currentDate, weekStartsOn, showWeekends);
  }, [viewType, currentDate, weekStartsOn, showWeekends]);

  // 日付範囲をISO 8601形式に変換（サーバーサイドフィルタ用）
  // toISOString()はTZ依存のためユーザーTZのローカル深夜をUTC ISOに変換して使用
  const dateFilter = useMemo(
    () => ({
      startDate: toTZStartISO(viewDateRange.start, timezone),
      endDate: toTZEndISO(viewDateRange.end, timezone),
    }),
    [viewDateRange, timezone],
  );

  // Step 8: entries を読まず、plans / records をそれぞれ取得する。
  const plansQuery = api.plans.list.useQuery({
    ...dateFilter,
    sortBy: 'start_at',
    sortOrder: 'asc',
  });
  const recordsQuery = api.records.list.useQuery({
    ...dateFilter,
    sortBy: 'start_at',
    sortOrder: 'asc',
  });

  // 外部カレンダーの ghost（#1962）。接続の有無を先に確かめると waterfall になるので、
  // enabled ゲートは置かず plans / records と同じ範囲で常に撃つ。未接続なら即 0 件が返る。
  const { events: externalEvents } = useExternalCalendarEvents(dateFilter);

  const timeblocksError = plansQuery.error ?? recordsQuery.error;
  const isTimeblocksLoading = plansQuery.isLoading || recordsQuery.isLoading;
  const isTimeblocksFetching = plansQuery.isFetching || recordsQuery.isFetching;
  const refetchTimeblocks = useCallback(
    () => Promise.all([plansQuery.refetch(), recordsQuery.refetch()]),
    [plansQuery, recordsQuery],
  );

  // アクティビティマスタ取得（TimeblockCard等で使用するためキャッシュをwarm up + フィルタ同期）
  const { data: activitiesData } = useActivities();
  // syncWithActivities にアーカイブ済み ID も含めるための取得（#1576 回帰防止）。
  const { data: archivedActivitiesData } = useArchivedActivities();
  const syncWithActivities = useCalendarFilterStore((state) => state.syncWithActivities);

  // アクティビティフィルタを activitiesData と同期（新規は visible として追加、削除済みは
  // orphan として除去）。アーカイブ済み ID を含めないと、archived アクティビティを持つ
  // 過去ブロックが orphan 扱いされ visibleActivityIds から消えてカレンダーから消えてしまう。
  // モバイルではサイドバーがマウントされないため、ここで保証する。
  //
  // `ActivityFilterList` も同じ store を sync するので、渡す ID 集合を揃えること
  // （ズレると後から走った方が相手の ID を orphan として消す）。
  useEffect(() => {
    const allActivityIds = [
      ...(activitiesData ?? []).map((activity) => activity.id),
      ...(archivedActivitiesData ?? []).map((activity) => activity.id),
    ];
    if (allActivityIds.length > 0) {
      syncWithActivities(allActivityIds);
    }
  }, [activitiesData, archivedActivitiesData, syncWithActivities]);

  // tRPC utils（プリフェッチ用）
  const utils = api.useUtils();

  // 隣接期間のプリフェッチ（ナビゲーション高速化、viewType別に最適化）
  useEffect(() => {
    const prefetchRange = (date: Date, view: CalendarViewType = viewType) => {
      const range = calculateViewDateRange(view, date, weekStartsOn, showWeekends);
      const input = {
        startDate: toTZStartISO(range.start, timezone),
        endDate: toTZEndISO(range.end, timezone),
        sortBy: 'start_at' as const,
        sortOrder: 'asc' as const,
      };
      void Promise.all([
        utils.plans.list.prefetch(input),
        utils.records.list.prefetch(input),
        // ghost も一緒に温める。載せないと日送りのたびに plan / record だけ即出て、
        // 外部予定が後追いでポップインする。
        utils.externalCalendar.listEvents.prefetch({
          startDate: input.startDate,
          endDate: input.endDate,
        }),
      ]);
    };

    if (viewType === 'day') {
      // dayビュー: 前後3日を個別にprefetch（日送りでのキャッシュヒット率向上）
      for (let i = 1; i <= 3; i++) {
        prefetchRange(subDays(currentDate, i));
        prefetchRange(addDays(currentDate, i));
      }
    } else if (isMultiDayView(viewType)) {
      // multi-dayビュー: 前後1期間分をprefetch
      prefetchRange(getPreviousPeriod(viewType, currentDate, showWeekends));
      prefetchRange(getNextPeriod(viewType, currentDate, showWeekends));
    } else {
      // weekビュー: 前後1週間をprefetch
      prefetchRange(subDays(currentDate, 7));
      prefetchRange(addDays(currentDate, 7));
    }
  }, [
    currentDate,
    viewType,
    weekStartsOn,
    showWeekends,
    timezone,
    utils.records.list,
    utils.plans.list,
    utils.externalCalendar.listEvents,
  ]);

  // 指定方向のナビゲーション先を事前取得（ホバー/タッチ時に呼ばれる）
  const prefetchDirection = useCallback(
    (direction: 'prev' | 'next' | 'today') => {
      let targetDate: Date;

      if (direction === 'today') {
        targetDate = new Date();
      } else {
        if (isMultiDayView(viewType)) {
          targetDate =
            direction === 'next'
              ? getNextPeriod(viewType, currentDate, showWeekends)
              : getPreviousPeriod(viewType, currentDate, showWeekends);
        } else {
          const multiplier = direction === 'next' ? 1 : -1;
          targetDate = new Date(currentDate);
          switch (viewType) {
            case 'day':
              targetDate.setDate(currentDate.getDate() + 1 * multiplier);
              break;
            case 'week':
            default:
              targetDate.setDate(currentDate.getDate() + 7 * multiplier);
          }
        }
      }

      const range = calculateViewDateRange(viewType, targetDate, weekStartsOn, showWeekends);
      const input = {
        startDate: toTZStartISO(range.start, timezone),
        endDate: toTZEndISO(range.end, timezone),
        sortBy: 'start_at' as const,
        sortOrder: 'asc' as const,
      };
      void Promise.all([
        utils.plans.list.prefetch(input),
        utils.records.list.prefetch(input),
        // ghost も一緒に温める。載せないと日送りのたびに plan / record だけ即出て、
        // 外部予定が後追いでポップインする。
        utils.externalCalendar.listEvents.prefetch({
          startDate: input.startDate,
          endDate: input.endDate,
        }),
      ]);
    },
    [
      currentDate,
      viewType,
      weekStartsOn,
      showWeekends,
      timezone,
      utils.records.list,
      utils.plans.list,
      utils.externalCalendar.listEvents,
    ],
  );

  // ビュー切り替え先の日付範囲を即座にprefetch（useEffect経由の1レンダー遅延を回避）
  const prefetchForView = useCallback(
    (newViewType: CalendarViewType) => {
      const range = calculateViewDateRange(newViewType, currentDate, weekStartsOn, showWeekends);
      const input = {
        startDate: toTZStartISO(range.start, timezone),
        endDate: toTZEndISO(range.end, timezone),
        sortBy: 'start_at' as const,
        sortOrder: 'asc' as const,
      };
      void Promise.all([
        utils.plans.list.prefetch(input),
        utils.records.list.prefetch(input),
        // ghost も一緒に温める。載せないと日送りのたびに plan / record だけ即出て、
        // 外部予定が後追いでポップインする。
        utils.externalCalendar.listEvents.prefetch({
          startDate: input.startDate,
          endDate: input.endDate,
        }),
      ]);
    },
    [
      currentDate,
      weekStartsOn,
      showWeekends,
      timezone,
      utils.records.list,
      utils.plans.list,
      utils.externalCalendar.listEvents,
    ],
  );

  // フィルター関数と状態を取得（ストアに統一）
  const isEntryVisible = useCalendarFilterStore((state) => state.isEntryVisible);
  // タグフィルタ変更時に useMemo を再実行させるためのリアクティブ依存
  // useDeferredValue でフィルター変更時のカレンダー再描画を遅延し、
  // チェックボックスUIの即時応答を維持する
  const visibleActivityIds = useDeferredValue(
    useCalendarFilterStore((state) => state.visibleActivityIds),
  );
  // 未分類(タグなし)フィルターの表示切替も同様にリアクティブ依存として渡す（#1576）

  // Step 8 の表示互換射影。既存のカードと DnD の段階的置換が完了するまで
  // CalendarDisplayEvent は view model としてだけ維持し、データ取得は time model に固定する。
  const allCalendarEvents = useMemo(() => {
    const visiblePlans = plansQuery.data ?? [];
    const visibleRecords = recordsQuery.data ?? [];
    const plans = visiblePlans;
    const records = visibleRecords;
    const now = new Date();
    const planEvents = plans.map((plan) => {
      const startDate = new Date(plan.start_at);
      const endDate = new Date(plan.end_at);
      const timeblockState = endDate <= now ? 'past' : startDate <= now ? 'active' : 'upcoming';
      return applyTimezoneToDisplayDates(
        {
          id: plan.id,
          title: plan.title,
          description: plan.note ?? undefined,
          startDate,
          endDate,
          status: timeblockState === 'past' ? 'closed' : 'open',
          color: '',
          activityId: plan.activity_id,
          createdAt: new Date(plan.created_at),
          updatedAt: new Date(plan.updated_at),
          version: plan.updated_at,
          displayStartDate: startDate,
          displayEndDate: endDate,
          duration: Math.round((endDate.getTime() - startDate.getTime()) / 60_000),
          isMultiDay: !tzIsSameDay(startDate, endDate, timezone),
          timeblockState,
          plannedStartDate: startDate,
          plannedEndDate: endDate,
          actualStartDate: null,
          actualEndDate: null,
          kind: 'plan' as const,
        },
        timezone,
      );
    });
    const recordRowsById = new Map(records.map((record) => [record.id, record] as const));
    const recordEvents = expandRecordRowsToRecordEvents(records, {
      timezone,
    }).map((record) => {
      const sourceRow = recordRowsById.get(record.id);
      if (!sourceRow) return null;

      return {
        id: record.id,
        title: record.title,
        description: record.note ?? undefined,
        startDate: record.startDate,
        endDate: record.endDate,
        status: 'closed' as const,
        color: '',
        activityId: record.activityId,
        createdAt: new Date(sourceRow.created_at),
        updatedAt: new Date(sourceRow.updated_at),
        version: sourceRow.updated_at,
        displayStartDate: record.displayStartDate,
        displayEndDate: record.displayEndDate,
        duration: record.duration,
        isMultiDay: !tzIsSameDay(record.startDate, record.endDate, timezone),
        timeblockState: 'past' as const,
        actualStartDate: record.startDate,
        actualEndDate: record.endDate,
        plannedStartDate: null,
        plannedEndDate: null,
        kind: 'record' as const,
        recordSource: sourceRow.source,
      };
    });
    return [...planEvents, ...recordEvents.filter((record) => record != null)];
  }, [plansQuery.data, recordsQuery.data, timezone]);

  // 表示範囲のイベントをフィルタリング
  const filteredEvents = useMemo(() => {
    if (allCalendarEvents.length === 0) {
      return [];
    }

    // 表示範囲内のイベントのみをフィルタリング。
    // 日次バケットはユーザーTZの yyyy-MM-dd を正とし、ブラウザTZでは再計算しない。
    const startDateKey = getDateKey(viewDateRange.start, timezone);
    const endDateKey = getDateKey(viewDateRange.end, timezone);

    const filtered = allCalendarEvents.filter((event) => {
      if (!event.startDate || !event.endDate) {
        return false;
      }
      const eventStartDateKey = getDateKey(event.startDate, timezone);
      const eventEndDateKey = getDateKey(event.endDate, timezone);

      return (
        (eventStartDateKey >= startDateKey && eventStartDateKey <= endDateKey) ||
        (eventEndDateKey >= startDateKey && eventEndDateKey <= endDateKey) ||
        (eventStartDateKey <= startDateKey && eventEndDateKey >= endDateKey)
      );
    });

    // サイドバーのフィルター設定を適用
    const visibilityFiltered = filtered.filter((event) => {
      return isEntryVisible(event.activityId ?? null);
    });

    return visibilityFiltered;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleActivityIds はリアクティブ依存（関数参照は安定のため直接依存不可）
  }, [viewDateRange, allCalendarEvents, timezone, isEntryVisible, visibleActivityIds]);

  return {
    viewDateRange,
    filteredEvents,
    allCalendarEvents,
    externalEvents,
    timeblocksError,
    isTimeblocksLoading,
    isTimeblocksFetching,
    refetchTimeblocks,
    prefetchDirection,
    prefetchForView,
  };
}
