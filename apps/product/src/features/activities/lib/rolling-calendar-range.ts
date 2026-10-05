import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

interface CalendarDaysRange {
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12);
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function zonedDayStart(dateKey: string, timezone: string): Date {
  return fromZonedTime(`${dateKey}T00:00:00.000`, timezone);
}

/** A half-open range of timezone-local calendar days, including the day containing `now`. */
export function resolveRollingCalendarDaysRange(
  timezone: string,
  now: Date = new Date(),
  dayCount = 30,
): CalendarDaysRange {
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    throw new RangeError('dayCount must be a positive integer');
  }

  const endDate = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const startDate = formatDateKey(addDays(parseDateKey(endDate), 1 - dayCount));
  const nextDate = formatDateKey(addDays(parseDateKey(endDate), 1));

  return {
    startAt: zonedDayStart(startDate, timezone).toISOString(),
    endAt: zonedDayStart(nextDate, timezone).toISOString(),
    startDate,
    endDate,
  };
}

/** Clip an interval to a half-open range and return its elapsed minutes. */
export function clipMinutes(
  blockStartAt: string,
  blockEndAt: string,
  rangeStartAt: string,
  rangeEndAt: string,
): number {
  const start = Math.max(Date.parse(blockStartAt), Date.parse(rangeStartAt));
  const end = Math.min(Date.parse(blockEndAt), Date.parse(rangeEndAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 60_000;
}
