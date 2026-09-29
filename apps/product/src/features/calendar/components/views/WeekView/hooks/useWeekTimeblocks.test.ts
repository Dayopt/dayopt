import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { useWeekTimeblocks } from './useWeekTimeblocks';

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
    useWeekTimeblocks({ weekDates, events: [plan], timezone: 'America/New_York' }),
  );

  expect(result.current.timeblocksByDate['2026-09-29']).toEqual([plan]);
  expect(result.current.timeblockPositions).toHaveLength(1);
  expect(result.current.timeblockPositions[0]?.dayIndex).toBe(1);
});
