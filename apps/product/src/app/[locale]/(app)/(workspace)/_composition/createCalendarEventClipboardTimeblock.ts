import type { CalendarDisplayEvent } from '@/features/calendar';
import { createClipboardTimeblock, type ClipboardTimeblock } from '@/features/timeblock';

/** Calendar の表示時刻を保ったまま、既存の貼り付け用データへ変換する。 */
export function createCalendarEventClipboardTimeblock(
  entry: CalendarDisplayEvent,
): ClipboardTimeblock {
  return createClipboardTimeblock({
    kind: entry.kind,
    title: entry.title,
    description: entry.description ?? null,
    startAt: entry.displayStartDate,
    endAt: entry.displayEndDate,
  });
}
