import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { useMultiDayTimeblockPositions } from './useMultiDayTimeblockPositions';

it('ニューヨーク時間の火曜日の予定は火曜日の列に配置される', () => {
  const plan: CalendarDisplayEvent = {
    id: 'tuesday',
    title: 'Tuesday plan',
    startDate: new Date('2026-09-29T16:14:00Z'),
    endDate: new Date('2026-09-29T17:14:00Z'),
    displayStartDate: new Date(2026, 8, 29, 12, 14),
    displayEndDate: new Date(2026, 8, 29, 13, 14),
    color: 'blue',
    duration: 60,
    isMultiDay: false,
    version: '2026-09-29T03:16:40.057861Z',
    kind: 'plan',
  };
  const weekDates = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 28 + index));
  const { result } = renderHook(() =>
    useMultiDayTimeblockPositions({
      displayDates: weekDates,
      timeblocks: [plan],
      timezone: 'America/New_York',
    }),
  );

  expect([...result.current.timeblocksByDate.keys()]).toEqual([
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
  ]);
  expect(result.current.timeblocksByDate.get('2026-09-29')).toEqual([plan]);
  expect(result.current.timeblocksByDate.get('2026-09-30')).toEqual([]);
  expect(result.current.timeblockPositions.map((position) => position.plan.id)).toEqual([
    'tuesday',
  ]);
});
