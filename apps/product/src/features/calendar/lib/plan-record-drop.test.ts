import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';
import { buildPlanRecordDropInput } from './plan-record-drop';

const plan = {
  id: 'plan-1',
  title: 'API design',
  description: 'Review the endpoint contract',
  activityId: 'activity-1',
  kind: 'plan',
  startDate: new Date('2026-07-14T09:00:00.000Z'),
  endDate: new Date('2026-07-14T10:00:00.000Z'),
} as CalendarDisplayEvent;

describe('buildPlanRecordDropInput', () => {
  it('Planの内容とdrop先のpreview rangeから独立Record入力を作る', () => {
    const input = buildPlanRecordDropInput(plan, {
      start: new Date('2026-07-14T10:15:00.000Z'),
      end: new Date('2026-07-14T10:45:00.000Z'),
    });

    expect(input).toEqual({
      title: 'API design',
      note: 'Review the endpoint contract',
      activityId: 'activity-1',
      start_at: '2026-07-14T10:15:00.000Z',
      end_at: '2026-07-14T10:45:00.000Z',
    });
    expect(input.start_at).not.toBe(plan.startDate?.toISOString());
    expect(input.end_at).not.toBe(plan.endDate?.toISOString());
  });

  it('未設定のメモとアクティビティをnullへ正規化する', () => {
    const input = buildPlanRecordDropInput(
      { ...plan, description: undefined, activityId: undefined },
      {
        start: new Date('2026-07-14T11:00:00.000Z'),
        end: new Date('2026-07-14T11:20:00.000Z'),
      },
    );

    expect(input).toMatchObject({ note: null, activityId: null });
  });
});
