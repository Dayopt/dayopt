import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

const RECORD_STACK_OFFSET = 100;

/** 同じ時間帯で重なる予定より、記録を前面に出すための z-index を返す。 */
export function getTimeblockStackIndex(
  entry: Pick<CalendarDisplayEvent, 'kind'>,
  orderIndex: number,
  base = 10,
): number {
  return base + orderIndex + (entry.kind === 'record' ? RECORD_STACK_OFFSET : 0);
}
