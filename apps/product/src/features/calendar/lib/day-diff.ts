import type { CalendarDisplayEvent } from '../types/calendar.types';

type CalendarDayDiffKind = 'unplanned' | 'missed' | 'shifted' | 'resized';

interface CalendarDayDiffItem {
  id: string;
  timeblockId: string;
  kind: CalendarDayDiffKind;
  title: string;
  activityId: string | null;
  color: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  plannedMinutes: number;
  actualMinutes: number;
  diffMinutes: number;
  startDiffMinutes: number;
  endDiffMinutes: number;
  sortTime: number;
}

interface CalendarDayDiffSummary {
  plannedMinutes: number;
  actualMinutes: number;
  diffMinutes: number;
  unplannedMinutes: number;
  missedMinutes: number;
}

interface CalendarDayDiffResult {
  summary: CalendarDayDiffSummary;
  items: CalendarDayDiffItem[];
  timeblockIds: ReadonlySet<string>;
}

interface CalendarDayDiffOptions {
  dayStart?: Date | null;
  dayEnd?: Date | null;
}

const EMPTY_RESULT: CalendarDayDiffResult = {
  summary: {
    plannedMinutes: 0,
    actualMinutes: 0,
    diffMinutes: 0,
    unplannedMinutes: 0,
    missedMinutes: 0,
  },
  items: [],
  timeblockIds: new Set<string>(),
};

function diffMinutes(start: Date | null | undefined, end: Date | null | undefined): number {
  if (!start || !end) return 0;
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60_000);
}

function minutesBetween(a: Date | null, b: Date | null): number {
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/**
 * Plan / Record いずれも時刻は `startDate` / `endDate` の 1 組しか持たない。
 * 旧 entries 統合モデルでは 1 件が予定と実績の両方を抱えていたが、Plan / Record
 * 分離モデルでは予定レンジと実績レンジが同一になる。
 */
function timeblockRange(timeblock: CalendarDisplayEvent): { start: Date | null; end: Date | null } {
  return { start: timeblock.startDate, end: timeblock.endDate };
}

function resolveOptions(input: CalendarDayDiffOptions | Date): CalendarDayDiffOptions {
  if (input instanceof Date) return {};
  return input;
}

function clipRange(
  range: { start: Date | null; end: Date | null },
  bounds: CalendarDayDiffOptions,
): { start: Date | null; end: Date | null } {
  if (!range.start || !range.end) return range;

  const dayStart = bounds.dayStart ?? null;
  const dayEnd = bounds.dayEnd ?? null;
  const clippedStart = dayStart && range.start < dayStart ? dayStart : range.start;
  const clippedEnd = dayEnd && range.end > dayEnd ? dayEnd : range.end;

  if (clippedEnd <= clippedStart) {
    return { start: null, end: null };
  }

  return { start: clippedStart, end: clippedEnd };
}

export function filterCalendarDayDiffTimeblocks(
  timeblocks: readonly CalendarDisplayEvent[],
  bounds: CalendarDayDiffOptions,
  isActivityVisible: (activityId: string | null) => boolean,
): CalendarDisplayEvent[] {
  return timeblocks.filter((timeblock) => {
    if (!isActivityVisible(timeblock.activityId ?? null)) return false;

    const range = clipRange(timeblockRange(timeblock), bounds);

    return diffMinutes(range.start, range.end) > 0;
  });
}

function makeItem(
  timeblock: CalendarDisplayEvent,
  kind: CalendarDayDiffKind,
  planned: { start: Date | null; end: Date | null },
  actual: { start: Date | null; end: Date | null },
): CalendarDayDiffItem {
  const plannedMinutes = diffMinutes(planned.start, planned.end);
  const actualMinutes = diffMinutes(actual.start, actual.end);

  return {
    id: `${kind}:${timeblock.id}`,
    timeblockId: timeblock.id,
    kind,
    title: timeblock.title,
    activityId: timeblock.activityId ?? null,
    color: timeblock.color,
    plannedStart: planned.start,
    plannedEnd: planned.end,
    actualStart: actual.start,
    actualEnd: actual.end,
    plannedMinutes,
    actualMinutes,
    diffMinutes: actualMinutes - plannedMinutes,
    startDiffMinutes: minutesBetween(planned.start, actual.start),
    endDiffMinutes: minutesBetween(planned.end, actual.end),
    sortTime: (actual.start ?? planned.start ?? timeblock.displayStartDate).getTime(),
  };
}

export function computeCalendarDayDiffs(
  timeblocks: readonly CalendarDisplayEvent[],
  options: CalendarDayDiffOptions | Date = {},
): CalendarDayDiffResult {
  if (timeblocks.length === 0) return EMPTY_RESULT;

  const bounds = resolveOptions(options);
  const items: CalendarDayDiffItem[] = [];
  let plannedMinutes = 0;
  let actualMinutes = 0;
  let unplannedMinutes = 0;
  const missedMinutes = 0;

  for (const timeblock of timeblocks) {
    if (timeblock.isDraft) continue;

    const range = clipRange(timeblockRange(timeblock), bounds);
    const duration = diffMinutes(range.start, range.end);

    if (timeblock.kind === 'record') {
      actualMinutes += duration;
      if (duration > 0) {
        unplannedMinutes += duration;
        items.push(makeItem(timeblock, 'unplanned', { start: null, end: null }, range));
      }
      continue;
    }

    // Plan は予定レンジと実績レンジが一致するため shifted / resized は生じない。
    plannedMinutes += duration;
    actualMinutes += duration;
  }

  items.sort((a, b) => a.sortTime - b.sortTime || a.title.localeCompare(b.title));

  const timeblockIds = new Set(items.map((item) => item.timeblockId));

  return {
    summary: {
      plannedMinutes,
      actualMinutes,
      diffMinutes: actualMinutes - plannedMinutes,
      unplannedMinutes,
      missedMinutes,
    },
    items,
    timeblockIds,
  };
}
