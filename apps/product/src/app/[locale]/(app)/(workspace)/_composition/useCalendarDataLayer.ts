'use client';

/**
 * Calendar Data Layer Hook
 *
 * データ取得・フィルタリング・エラー通知を担当。
 * viewDateRange / filteredEvents / allCalendarEvents を安定オブジェクトで返す。
 */

import { useEffect, useMemo } from 'react';

import type { CalendarDisplayEvent, CalendarViewType, ViewDateRange } from '@/features/calendar';
import { useCalendarData } from '@/features/calendar';
import type { ExternalCalendarEvent } from '@/features/external-calendar';
import { logger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';

// =============================================================================
// Types
// =============================================================================

interface CalendarDataLayerInput {
  viewType: CalendarViewType;
  currentDate: Date;
  showWeekends: boolean;
}

interface CalendarDataLayerResult {
  viewDateRange: ViewDateRange;
  filteredEvents: CalendarDisplayEvent[];
  allCalendarEvents: CalendarDisplayEvent[];
  /** 外部カレンダーの未変換予定（ghost）。取得失敗時は空配列で、calendar 全体は落とさない */
  externalEvents: ExternalCalendarEvent[];
  /** バックグラウンド再取得を含む取得中フラグ */
  isFetching: boolean;
  /** ナビゲーション方向に対応する日付範囲を事前取得する */
  prefetchDirection: (direction: 'prev' | 'next' | 'today') => void;
  /** ビュー切り替え先の日付範囲を即座に事前取得する */
  prefetchForView: (newViewType: CalendarViewType) => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useCalendarDataLayer({
  viewType,
  currentDate,
  showWeekends,
}: CalendarDataLayerInput): CalendarDataLayerResult {
  const tError = useTranslations('calendar.error');

  const {
    viewDateRange,
    filteredEvents,
    allCalendarEvents,
    externalEvents,
    timeblocksError,
    isTimeblocksFetching,
    refetchTimeblocks,
    prefetchDirection,
    prefetchForView,
  } = useCalendarData({
    viewType,
    currentDate,
    showWeekends,
  });

  // タイムブロック取得エラー時にtoast通知 + 再試行アクション
  useEffect(() => {
    if (timeblocksError) {
      logger.error('[useCalendarDataLayer] timeblocks fetch error', timeblocksError);
      toast.error(tError('loadFailed'), {
        action: {
          label: tError('retry'),
          onClick: () => {
            void refetchTimeblocks();
          },
        },
      });
    }
  }, [timeblocksError, tError, refetchTimeblocks]);

  return useMemo(
    () => ({
      viewDateRange,
      filteredEvents,
      allCalendarEvents,
      externalEvents,
      isFetching: isTimeblocksFetching,
      prefetchDirection,
      prefetchForView,
    }),
    [
      viewDateRange,
      filteredEvents,
      allCalendarEvents,
      externalEvents,
      isTimeblocksFetching,
      prefetchDirection,
      prefetchForView,
    ],
  );
}
