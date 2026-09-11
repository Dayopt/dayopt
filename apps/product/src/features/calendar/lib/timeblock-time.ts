import type { CalendarDisplayEvent } from '../types/calendar.types';

/** Plan の予定と記録が、リサイズ開始前から異なっているかを判定する。 */
export function hasCalendarActualRangeDiff(
  entry: CalendarDisplayEvent | null | undefined,
): boolean {
  if (entry?.kind !== 'plan') return false;

  const plannedStart = entry.plannedStartDate ?? entry.startDate;
  const plannedEnd = entry.plannedEndDate ?? entry.endDate;
  const actualStart = entry.actualStartDate;
  const actualEnd = entry.actualEndDate;

  return (
    plannedStart?.getTime() !== actualStart?.getTime() ||
    plannedEnd?.getTime() !== actualEnd?.getTime()
  );
}
