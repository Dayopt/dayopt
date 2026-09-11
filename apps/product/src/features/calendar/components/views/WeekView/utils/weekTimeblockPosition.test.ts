import { describe, expect, it } from 'vitest';

import type { TimeblockPosition } from '../../shared/hooks/useViewTimeblocks';
import { toWeekDayTimeblockPosition } from './weekTimeblockPosition';

const basePosition: TimeblockPosition = {
  plan: {
    id: 'entry-1',
    title: 'Entry',
    startDate: new Date('2026-06-04T13:00:00'),
    endDate: new Date('2026-06-04T14:00:00'),
    displayStartDate: new Date('2026-06-04T13:00:00'),
    displayEndDate: new Date('2026-06-04T14:00:00'),
    status: 'open',
    color: 'blue',
    duration: 60,
    isMultiDay: false,
    createdAt: new Date('2026-06-04T00:00:00'),
    updatedAt: new Date('2026-06-04T00:00:00'),
    version: '2026-06-04T00:00:00.000000Z',
    kind: 'record',
  },
  top: 100,
  height: 60,
  left: 0,
  width: 100,
  zIndex: 120,
  column: 1,
  totalColumns: 2,
};

describe('toWeekDayTimeblockPosition', () => {
  it('週全体ではなく1日カラム内の横割り位置へ変換する', () => {
    expect(toWeekDayTimeblockPosition(basePosition)).toMatchObject({
      left: 50,
      width: 50,
      column: 1,
      totalColumns: 2,
      zIndex: 120,
    });
  });
});
