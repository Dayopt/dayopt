'use client';

import { useCallback, useDeferredValue, useEffect, useMemo } from 'react';

import { useActivities, useArchivedActivities } from '@/features/activities';
import {
  useExternalCalendarEvents,
  type ExternalCalendarEvent,
} from '@/features/external-calendar';
import { getDateKey } from '@/lib/date';
import { tzIsSameDay } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { api } from '@/lib/trpc';

import { useCalendarFilterStore } from '@/features/calendar/stores/useCalendarFilterStore';

import { isActivityVisible } from '../../../domain/activity-visibility';

import {
  buildCalendarRangeInput,
  buildTimeblockListInput,
} from '../../../domain/calendar-query-input';
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
  /** タイムブロック取得を手動で再試行する */
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

  // query input は server prefetch（calendar-prefetch.ts）と同じ builder で組む。
  // 別実装にすると query key がずれ、server で先読みした cache を初回表示で使えない（#2747）。
  const anchorDateKey = getDateKey(currentDate);
  const listInput = useMemo(
    () =>
      buildTimeblockListInput({ viewType, anchorDateKey, timezone, weekStartsOn, showWeekends }),
    [viewType, anchorDateKey, timezone, weekStartsOn, showWeekends],
  );
  const dateFilter = useMemo(
    () => ({ startDate: listInput.startDate, endDate: listInput.endDate }),
    [listInput],
  );

  // Step 8: timeblocks を読まず、plans / records をそれぞれ取得する。
  const plansQuery = api.plans.list.useQuery(listInput);
  const recordsQuery = api.records.list.useQuery(listInput);

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

  const prefetchRange = useCallback(
    (options: Parameters<typeof buildTimeblockListInput>[0]) => {
      const input = buildTimeblockListInput(options);
      void Promise.all([
        utils.plans.list.prefetch(input),
        utils.records.list.prefetch(input),
        // ghost も一緒に温める。載せないと日送りのたびに plan / record だけ即出て、
        // 外部予定が後追いでポップインする。
        utils.externalCalendar.listEvents.prefetch(buildCalendarRangeInput(options)),
      ]);
    },
    [utils.records.list, utils.plans.list, utils.externalCalendar.listEvents],
  );

  // 未表示の期間は自動取得せず、ナビゲーション操作時に対象期間だけ先読みする。
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

      prefetchRange({
        viewType,
        anchorDateKey: getDateKey(targetDate),
        timezone,
        weekStartsOn,
        showWeekends,
      });
    },
    [prefetchRange, currentDate, viewType, weekStartsOn, showWeekends, timezone],
  );

  // ビュー切り替え先の日付範囲を即座にprefetch（useEffect経由の1レンダー遅延を回避）
  const prefetchForView = useCallback(
    (newViewType: CalendarViewType) => {
      prefetchRange({
        viewType: newViewType,
        anchorDateKey,
        timezone,
        weekStartsOn,
        showWeekends,
      });
    },
    [prefetchRange, anchorDateKey, weekStartsOn, showWeekends, timezone],
  );

  // フィルター関数と状態を取得（ストアに統一）
  const filterInitialized = useCalendarFilterStore((state) => state.initialized);
  const visibleActivityIds = useCalendarFilterStore((state) => state.visibleActivityIds);
  // タグフィルタ変更時に useMemo を再実行させるためのリアクティブ依存
  // useDeferredValue でフィルター変更時のカレンダー再描画を遅延し、
  // チェックボックスUIの即時応答を維持する
  const deferredFilterState = useDeferredValue(
    useMemo(
      () => ({ initialized: filterInitialized, visibleActivityIds }),
      [filterInitialized, visibleActivityIds],
    ),
  );
  // 未分類(タグなし)フィルターの表示切替も同様にリアクティブ依存として渡す（#1576）

  // plans / records から表示用射影（CalendarDisplayEvent）を組む。
  // CalendarDisplayEvent は view model としてだけ維持し、データ取得は time model に固定する。
  const allCalendarEvents = useMemo(() => {
    const visiblePlans = plansQuery.data ?? [];
    const visibleRecords = recordsQuery.data ?? [];
    const plans = visiblePlans;
    const records = visibleRecords;
    const planEvents = plans.map((plan) => {
      const startDate = new Date(plan.start_at);
      const endDate = new Date(plan.end_at);
      return applyTimezoneToDisplayDates(
        {
          id: plan.id,
          title: plan.title,
          description: plan.note ?? undefined,
          startDate,
          endDate,
          color: '',
          activityId: plan.activity_id,
          version: plan.updated_at,
          displayStartDate: startDate,
          displayEndDate: endDate,
          duration: Math.round((endDate.getTime() - startDate.getTime()) / 60_000),
          isMultiDay: !tzIsSameDay(startDate, endDate, timezone),
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
        color: '',
        activityId: record.activityId,
        version: sourceRow.updated_at,
        displayStartDate: record.displayStartDate,
        displayEndDate: record.displayEndDate,
        duration: record.duration,
        isMultiDay: !tzIsSameDay(record.startDate, record.endDate, timezone),
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
      return isActivityVisible(
        event.activityId ?? null,
        deferredFilterState.initialized,
        deferredFilterState.visibleActivityIds,
      );
    });

    return visibilityFiltered;
  }, [viewDateRange, allCalendarEvents, timezone, deferredFilterState]);

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
