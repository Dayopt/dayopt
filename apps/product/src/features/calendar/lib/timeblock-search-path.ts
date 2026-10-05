import { DEFAULT_LOCALE } from '@dayopt/config';
import { formatInTimeZone } from 'date-fns-tz';

import {
  serializeTimeblockParam,
  TIMEBLOCK_PARAM,
  type TimeblockDestination,
} from '@/features/timeblock';

import { formatCalendarDateParam, parseCalendarDateParam } from './date-param';

/** 検索結果の開始日時をCalendarが保持するローカル正午の日付へ変換する。 */
export function resolveTimeblockSearchResultDate(startAt: string, timezone: string): Date {
  const dateParam = formatInTimeZone(new Date(startAt), timezone, 'yyyy-MM-dd');
  const date = parseCalendarDateParam(dateParam);
  if (!date) throw new TypeError('Unable to resolve timeblock search result date');
  return date;
}

/** 検索結果を対象日の Calendar day view とインスペクターへ接続する。 */
export function buildTimeblockSearchResultPath({
  locale,
  startAt,
  timezone,
  timeblockId,
  kind,
}: {
  locale: string;
  startAt: string;
  timezone: string;
  timeblockId: string;
  kind: TimeblockDestination;
}): string {
  const params = new URLSearchParams();
  params.set('date', formatCalendarDateParam(resolveTimeblockSearchResultDate(startAt, timezone)));
  params.set('view', 'day');
  params.set(TIMEBLOCK_PARAM, serializeTimeblockParam(timeblockId, kind));
  const localePrefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`;
  return `${localePrefix}/?${params.toString()}`;
}
