/**
 * レポートの時間表記。
 *
 * `h:mm` 形式で、時はゼロ埋めしない（`0:45` / `14:00` / `92:40`）。時間が 3 桁になっても
 * そのまま伸ばす（週の分母は 168 時間で、年粒度なら 4 桁もありうる）。
 *
 * `lib/date/duration.ts` の `formatDurationMinutes` は `1h 30m` 形式で、レポートの
 * 決算表示では桁が揃わず読みづらいため別に持つ。
 */
export function formatReportDuration(totalMinutes: number): string {
  const totalWholeMinutes = Math.round(Math.abs(totalMinutes));
  const hours = Math.floor(totalWholeMinutes / 60);
  const minutes = totalWholeMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** 符号付きの時間表記（前期間との差）。0 は `+0:00` ではなく `0:00`。 */
export function formatReportDelta(deltaMinutes: number): string {
  const whole = Math.round(deltaMinutes);
  const body = formatReportDuration(whole);
  if (whole > 0) return `+${body}`;
  if (whole < 0) return `−${body}`;
  return body;
}

/**
 * 読み物向けの時間表記（`28時間40分` / `12分` / `3時間`、英語は `28h 40m` / `12m` / `3h`）。
 *
 * 時間の使い方の面で使う。`h:mm` は桁が揃う代わりに `0:12` が 12 分に読めないので、
 * 数字を 1 つずつ読むカードやグラフの注記ではこちらにする。0 は `0分` / `0m`。
 */
export function formatReportSpan(totalMinutes: number, locale: string): string {
  const totalWholeMinutes = Math.round(Math.abs(totalMinutes));
  const hours = Math.floor(totalWholeMinutes / 60);
  const minutes = totalWholeMinutes % 60;
  const ja = locale === 'ja';

  if (hours === 0) return ja ? `${minutes}分` : `${minutes}m`;
  if (minutes === 0) return ja ? `${hours}時間` : `${hours}h`;
  return ja ? `${hours}時間${minutes}分` : `${hours}h ${minutes}m`;
}

/** 符号付きの読み物向け表記（前期間との差）。0 は符号を付けない。 */
export function formatReportSpanDelta(deltaMinutes: number, locale: string): string {
  const whole = Math.round(deltaMinutes);
  const body = formatReportSpan(whole, locale);
  if (whole > 0) return `+${body}`;
  if (whole < 0) return `−${body}`;
  return body;
}
