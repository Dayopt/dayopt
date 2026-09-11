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

function plannedRange(entry: CalendarDisplayEvent): { start: Date | null; end: Date | null } {
  return {
    start: entry.plannedStartDate ?? entry.startDate,
    end: entry.plannedEndDate ?? entry.endDate,
  };
}

function actualRange(entry: CalendarDisplayEvent): { start: Date | null; end: Date | null } {
  if (entry.kind === 'record') {
    return {
      start: entry.actualStartDate ?? entry.startDate,
      end: entry.actualEndDate ?? entry.endDate,
    };
  }

  const planned = plannedRange(entry);
  return {
    start: entry.actualStartDate ?? planned.start,
    end: entry.actualEndDate ?? planned.end,
  };
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

export function filterCalendarDayDiffEntries(
  entries: readonly CalendarDisplayEvent[],
  bounds: CalendarDayDiffOptions,
  isEntryVisible: (activityId: string | null) => boolean,
): CalendarDisplayEvent[] {
  return entries.filter((entry) => {
    if (!isEntryVisible(entry.activityId ?? null)) return false;

    const planned = clipRange(plannedRange(entry), bounds);
    const actual = clipRange(actualRange(entry), bounds);

    return diffMinutes(planned.start, planned.end) > 0 || diffMinutes(actual.start, actual.end) > 0;
  });
}

function makeItem(
  entry: CalendarDisplayEvent,
  kind: CalendarDayDiffKind,
  planned: { start: Date | null; end: Date | null },
  actual: { start: Date | null; end: Date | null },
): CalendarDayDiffItem {
  const plannedMinutes = diffMinutes(planned.start, planned.end);
  const actualMinutes = diffMinutes(actual.start, actual.end);

  return {
    id: `${kind}:${entry.id}`,
    timeblockId: entry.id,
    kind,
    title: entry.title,
    activityId: entry.activityId ?? null,
    color: entry.color,
    plannedStart: planned.start,
    plannedEnd: planned.end,
    actualStart: actual.start,
    actualEnd: actual.end,
    plannedMinutes,
    actualMinutes,
    diffMinutes: actualMinutes - plannedMinutes,
    startDiffMinutes: minutesBetween(planned.start, actual.start),
    endDiffMinutes: minutesBetween(planned.end, actual.end),
    sortTime: (actual.start ?? planned.start ?? entry.displayStartDate).getTime(),
  };
}

export function computeCalendarDayDiffs(
  entries: readonly CalendarDisplayEvent[],
  options: CalendarDayDiffOptions | Date = {},
): CalendarDayDiffResult {
  if (entries.length === 0) return EMPTY_RESULT;

  const bounds = resolveOptions(options);
  const items: CalendarDayDiffItem[] = [];
  let plannedMinutes = 0;
  let actualMinutes = 0;
  let unplannedMinutes = 0;
  const missedMinutes = 0;

  for (const entry of entries) {
    if (entry.isDraft) continue;

    const planned = clipRange(plannedRange(entry), bounds);
    const actual = clipRange(actualRange(entry), bounds);
    const plannedDuration = diffMinutes(planned.start, planned.end);
    const actualDuration = diffMinutes(actual.start, actual.end);
    const countedActualDuration = actualDuration;
    const hasActualEdit = entry.actualStartDate != null || entry.actualEndDate != null;

    if (entry.kind !== 'record') {
      plannedMinutes += plannedDuration;
    }
    actualMinutes += countedActualDuration;

    if (entry.kind === 'record') {
      if (actualDuration > 0) {
        unplannedMinutes += actualDuration;
        items.push(makeItem(entry, 'unplanned', { start: null, end: null }, actual));
      }
      continue;
    }

    const hasActual = actual.start != null && actual.end != null && actualDuration > 0;
    if (!hasActual) {
      if (plannedDuration > 0 && hasActualEdit) {
        items.push(makeItem(entry, 'shifted', planned, { start: null, end: null }));
      }
      continue;
    }

    const startDiffMinutes = minutesBetween(planned.start, actual.start);
    const endDiffMinutes = minutesBetween(planned.end, actual.end);
    const durationDiffMinutes = actualDuration - plannedDuration;

    if (startDiffMinutes === 0 && endDiffMinutes === 0 && durationDiffMinutes === 0) {
      continue;
    }

    const kind: CalendarDayDiffKind = startDiffMinutes === 0 ? 'resized' : 'shifted';
    items.push(makeItem(entry, kind, planned, actual));
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
