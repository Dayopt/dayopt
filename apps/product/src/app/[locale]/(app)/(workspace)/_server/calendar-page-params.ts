import { getTranslations } from 'next-intl/server';

import type { CalendarViewType, MultiDayViewType } from '@/features/calendar';
import { isValidCalendarViewToken } from '@/lib/calendar-view-tokens';
import type { Locale } from '@dayopt/i18n/routing';

/** URL segmentをサポート対象のmulti-day view（2day〜7day）として解析する。 */
export function parseMultiDayViewParam(nday: string): MultiDayViewType | null {
  return isValidCalendarViewToken(nday) && nday !== 'day' && nday !== 'week'
    ? (nday as MultiDayViewType)
    : null;
}

/**
 * `/?view=` の値を CalendarViewType として解析する。
 *
 * `view` 省略時（undefined）は呼び出し側で week として扱う（呼び出し側の責務）。
 * 値が指定されていて day/week/2〜7day のいずれにも一致しない場合のみ null を返し、
 * 呼び出し側で 404 にする（範囲外は redirect せず 404 のまま、という現行 [nday] の
 * 挙動を維持するため）。トークン集合は proxy.ts（Edge runtime）と共有する
 * `@/lib/calendar-view-tokens` が正本（`AGENTS.md §PR / git 運用` §同型指摘の打ち切り
 * に従い、旧実装の定数複製 + parity test を単一定義への統一へ置き換えた）。
 */
export function parseCalendarViewParam(view: string | undefined): CalendarViewType | null {
  if (view === undefined) return null;
  return isValidCalendarViewToken(view) ? (view as CalendarViewType) : null;
}

/**
 * カレンダービューの翻訳テキストを取得する
 */
export async function getCalendarTranslations(locale: Locale) {
  const t = await getTranslations({ locale });
  return {
    errorTitle: t('calendar.errors.loadFailed'),
    errorMessage: t('calendar.errors.displayFailed'),
    reloadButton: t('common.reload'),
  };
}
