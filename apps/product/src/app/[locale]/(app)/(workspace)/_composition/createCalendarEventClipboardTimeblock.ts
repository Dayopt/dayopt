import type { CalendarDisplayEvent } from '@/features/calendar';
import { createClipboardTimeblock, type ClipboardTimeblock } from '@/features/timeblock';

/** Calendar の表示時刻を保ったまま、既存の貼り付け用データへ変換する。 */
export function createCalendarEventClipboardTimeblock(
  timeblock: CalendarDisplayEvent,
): ClipboardTimeblock {
  return createClipboardTimeblock({
    kind: timeblock.kind,
    title: timeblock.title,
    description: timeblock.description ?? null,
    startAt: timeblock.displayStartDate,
    endAt: timeblock.displayEndDate,
  });
}
