import type { CalendarDisplayEvent } from '../types/calendar.types';

/** Build the timeblock shown while a move or resize is in progress. */
export function buildDragPreviewTimeblock(
  timeblock: CalendarDisplayEvent,
  previewTime: { start: Date; end: Date },
): CalendarDisplayEvent {
  const duration = Math.max(
    1,
    Math.round((previewTime.end.getTime() - previewTime.start.getTime()) / 60_000),
  );

  return {
    ...timeblock,
    startDate: previewTime.start,
    endDate: previewTime.end,
    displayStartDate: previewTime.start,
    displayEndDate: previewTime.end,
    duration,
  };
}
