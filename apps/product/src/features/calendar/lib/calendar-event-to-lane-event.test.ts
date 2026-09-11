import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import { calendarEventToRecordEvent } from './calendar-event-to-lane-event';

const startDate = new Date('2026-07-10T09:00:00.000Z');
const endDate = new Date('2026-07-10T09:30:00.000Z');

function makeRecordEvent(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  return {
    id: 'record-1',
    title: 'Deep Work',
    startDate,
    endDate,
    status: 'closed',
    color: '',
    createdAt: startDate,
    updatedAt: startDate,
    version: '2026-07-15T00:00:00.000000Z',
    displayStartDate: startDate,
    displayEndDate: endDate,
    duration: 30,
    isMultiDay: false,
    timeblockState: 'past',
    kind: 'record',
    recordSource: 'from_plan',
    ...overrides,
  };
}

describe('calendarEventToRecordEvent', () => {
  it('集約済みの合計差分を代表Recordへ引き継ぐ', () => {
    const event = calendarEventToRecordEvent(makeRecordEvent({}));

    expect(event).toMatchObject({
      id: 'record-1',
      duration: 30,
    });
  });

  it('secondary Recordは個別のPlan差分を再計算しない', () => {
    const event = calendarEventToRecordEvent(
      makeRecordEvent({ id: 'record-2', recordSource: 'manual' }),
    );

    expect(event).not.toHaveProperty('diffMinutes');
  });
});
