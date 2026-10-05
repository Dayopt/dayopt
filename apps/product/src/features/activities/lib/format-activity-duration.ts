/** Readable elapsed duration for activity summaries (for example, 1h 30m or 1時間30分). */
export function formatActivityDuration(totalMinutes: number, locale: string): string {
  const wholeMinutes = Math.round(Math.abs(totalMinutes));
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  const japanese = locale === 'ja';

  if (hours === 0) return japanese ? `${minutes}分` : `${minutes}m`;
  if (minutes === 0) return japanese ? `${hours}時間` : `${hours}h`;
  return japanese ? `${hours}時間${minutes}分` : `${hours}h ${minutes}m`;
}
