/**
 * `/?view=` の正規トークン一覧（day / week / 2day〜7day）
 *
 * proxy.ts（Edge runtime）、`(workspace)/_server/calendar-page-params.ts`、
 * `features/calendar` の `CalendarNavigationContext.tsx` の3箇所が同じ集合を判定に使う。
 * `calendar-page-params.ts` は `next-intl/server` 等 Node 依存を持つため Edge runtime
 * （proxy.ts）から直接 import できない。この定数だけを持つ feature 非依存モジュールへ
 * 切り出し、3箇所から共有することで判定の drift を構造的に防ぐ。
 */
const CALENDAR_VIEW_TOKENS = [
  'day',
  'week',
  '2day',
  '3day',
  '4day',
  '5day',
  '6day',
  '7day',
] as const;

const CALENDAR_VIEW_TOKEN_SET = new Set<string>(CALENDAR_VIEW_TOKENS);

/** `view` の値がホームカレンダーの `?view=` の正規トークンかどうかを判定する。 */
export function isValidCalendarViewToken(value: string): boolean {
  return CALENDAR_VIEW_TOKEN_SET.has(value);
}
