import type { CalendarViewType } from '@/features/calendar';
import {
  buildCalendarRangeInput,
  buildTimeblockListInput,
  DEFAULT_SHOW_WEEKENDS,
  DEFAULT_WEEK_STARTS_ON,
  parseCalendarDateParam,
} from '@/features/calendar';
import { logger } from '@/lib/logger';
import { getRequestCalendarDate } from '@/lib/server/request-calendar-date';
import { createServerHelpers, dehydrate } from '@/lib/trpc/server';

/**
 * カレンダービュー用 prefetch（day/week/Nday）
 *
 * client の `useCalendarData` と**同じ builder・同じ設定値**で input を組み、
 * dehydrate した cache が client query にそのまま hydrate されるようにする（#2747）。
 *
 * - 範囲の timezone / weekStartsOn / showWeekends は user_settings を正とする。client は
 *   `UserSettingsInitializer` が settings の確定まで描画を止めるので、同じ値で query を撃つ
 * - row の無い新規ユーザーは client の既定（browser TZ / 月曜 / 週末表示）に合わせる
 * - settings を取得できない時（未認証・DB エラー）は、曖昧な既定値で先読みしても key が
 *   揃わないので calendar 範囲の prefetch 自体をやめる。client 側で通常どおり取得される
 */
export async function prefetchCalendarData(view: CalendarViewType, dateParam: string | undefined) {
  const helpers = await createServerHelpers();

  const requestCalendarDate = await getRequestCalendarDate();

  try {
    const settings = await helpers.userSettings.get.fetch();

    // parse 失敗（不正な ?date=）は client も今日に倒すので揃う
    const anchorDateKey = parseCalendarDateParam(dateParam)
      ? (dateParam as string)
      : requestCalendarDate.dateKey;

    const rangeOptions = {
      viewType: view,
      anchorDateKey,
      timezone: settings?.timezone ?? requestCalendarDate.timezone,
      weekStartsOn: settings?.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON,
      showWeekends: settings?.showWeekends ?? DEFAULT_SHOW_WEEKENDS,
    };
    const listInput = buildTimeblockListInput(rangeOptions);

    // prefetch は失敗を投げない（TanStack Query の prefetchQuery）。失敗した query は
    // dehydrate されず、client 側で取り直される。
    await Promise.all([
      helpers.plans.list.prefetch(listInput),
      helpers.records.list.prefetch(listInput),
      helpers.externalCalendar.listEvents.prefetch(buildCalendarRangeInput(rangeOptions)),
      helpers.statistics.getActivityStats.prefetch(),
    ]);
  } catch (error) {
    // 認証エラー（UNAUTHORIZED）等の場合はprefetchをスキップ
    // クライアント側のtRPCがリトライ or 認証リダイレクトを処理する
    logger.warn('prefetchCalendarData failed (possibly unauthenticated):', error);
  }

  return { helpers, dehydratedState: dehydrate(helpers.queryClient) };
}
