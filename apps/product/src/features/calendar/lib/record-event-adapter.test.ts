import { describe, expect, it } from 'vitest';

import {
  expandRecordRowsToRecordEvents,
  recordRowToRecordEvent,
  type RecordEventSourceRow,
} from './record-event-adapter';

function makeRow(overrides: Partial<RecordEventSourceRow> = {}): RecordEventSourceRow {
  return {
    id: 'record-1',
    title: 'Deep Work',
    note: null,
    activity_id: null,

    source: 'manual',
    start_at: '2026-07-10T09:00:00Z',
    end_at: '2026-07-10T10:00:00Z',
    ...overrides,
  };
}

describe('independent record projection', () => {
  it('preserves each record and does not derive a paired difference from legacy link data', () => {
    const rows = [
      { ...makeRow({ source: 'from_plan' }), plan_id: 'legacy-plan' },
      makeRow({ id: 'record-2', start_at: '2026-07-10T11:00:00Z', end_at: '2026-07-10T12:30:00Z' }),
    ];
    const events = expandRecordRowsToRecordEvents(rows, { timezone: 'UTC' });
    expect(events.map((event) => event.duration)).toEqual([60, 90]);
    expect(events.map((event) => event.id)).toEqual(['record-1', 'record-2']);
    expect(events.every((event) => !('diffMinutes' in event) && !('planId' in event))).toBe(true);
  });
  it('converts display timezone without changing elapsed duration', () => {
    const event = recordRowToRecordEvent(makeRow(), { timezone: 'Asia/Tokyo' });
    expect(event.duration).toBe(60);
    expect(event.displayStartDate.getHours()).toBe(18);
    expect(event.startDate.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });
});
