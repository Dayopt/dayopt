import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { useTimeblocksByDate } from './useTimeblocksByDate';

function createTimeblock(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
  return {
    id: 'new-york-tuesday',
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
    ...overrides,
  };
}

describe('useTimeblocksByDate display dates', () => {
  it('ニューヨーク時間の火曜日の予定を表示上の火曜日に分類する', () => {
    const timeblock = createTimeblock();
    const dates = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 28 + index));
    const { result } = renderHook(() =>
      useTimeblocksByDate({ dates, timeblocks: [timeblock], timezone: 'America/New_York' }),
    );

    expect(Object.keys(result.current.timeblocksByDate)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(result.current.timeblocksByDate['2026-09-29']).toEqual([timeblock]);
    expect(result.current.timeblocksByDate['2026-09-30']).toEqual([]);
  });

  it.each([
    ['America/New_York', '2026-09-29T00:30:00Z', '2026-09-28'],
    ['Asia/Tokyo', '2026-09-29T23:30:00Z', '2026-09-30'],
    ['UTC', '2026-09-29T16:14:00Z', '2026-09-29'],
  ])('%sの実時刻%sを対応する暦日に分類する', (timezone, start, expectedDate) => {
    const startDate = new Date(start);
    const timeblock = createTimeblock({
      startDate,
      endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
      kind: 'record',
    });
    const dates = Array.from({ length: 7 }, (_, index) => new Date(2026, 8, 28 + index));
    const { result } = renderHook(() =>
      useTimeblocksByDate({ dates, timeblocks: [timeblock], timezone }),
    );

    expect(result.current.timeblocksByDate[expectedDate]).toEqual([timeblock]);
    expect(result.current.totalTimeblocks).toBe(1);
  });

  it('複数日にまたがる予定を表示日付の範囲に分類する', () => {
    const timeblock = createTimeblock({
      startDate: new Date('2026-09-29T03:00:00Z'),
      endDate: new Date('2026-09-29T06:00:00Z'),
      displayStartDate: new Date(2026, 8, 28, 23),
      displayEndDate: new Date(2026, 8, 29, 2),
      duration: 180,
      isMultiDay: true,
    });
    const dates = [new Date(2026, 8, 28), new Date(2026, 8, 29), new Date(2026, 8, 30)];
    const { result } = renderHook(() =>
      useTimeblocksByDate({ dates, timeblocks: [timeblock], timezone: 'America/New_York' }),
    );

    expect(result.current.timeblocksByDate).toEqual({
      '2026-09-28': [timeblock],
      '2026-09-29': [timeblock],
      '2026-09-30': [],
    });
  });

  it('無効な開始時刻と表示範囲外の予定を除外する', () => {
    const timeblocks = [
      createTimeblock({ startDate: null }),
      createTimeblock({ startDate: new Date('invalid') }),
      createTimeblock({ startDate: new Date('2026-09-27T16:00:00Z') }),
    ];
    const { result } = renderHook(() =>
      useTimeblocksByDate({
        dates: [new Date(2026, 8, 29)],
        timeblocks,
        timezone: 'America/New_York',
      }),
    );

    expect(result.current.timeblocksByDate).toEqual({ '2026-09-29': [] });
    expect(result.current.hasTimeblocks).toBe(false);
  });
});
