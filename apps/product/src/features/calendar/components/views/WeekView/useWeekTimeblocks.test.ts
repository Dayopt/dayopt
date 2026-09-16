import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../types/calendar.types';
import { useWeekTimeblocks } from './hooks/useWeekTimeblocks';

const createMockTimeblock = (
  overrides: Partial<CalendarDisplayEvent> = {},
): CalendarDisplayEvent => ({
  id: `timeblock-${Math.random().toString(36).slice(2)}`,
  title: 'Test Timeblock',
  startDate: new Date('2026-03-30T10:00:00'),
  endDate: new Date('2026-03-30T11:00:00'),
  displayStartDate: new Date('2026-03-30T10:00:00'),
  displayEndDate: new Date('2026-03-30T11:00:00'),
  color: 'blue',
  duration: 60,
  isMultiDay: false,
  version: '2026-07-15T00:00:00.000000Z',
  kind: 'plan',
  ...overrides,
});

// 2026-03-30(月)〜04-05(日) の週
const weekDates = Array.from({ length: 7 }, (_, i) => {
  const d = new Date('2026-03-30');
  d.setDate(d.getDate() + i);
  return d;
});

describe('useWeekTimeblocks', () => {
  it('タイムブロックがない場合は空のpositionsを返す', () => {
    const { result } = renderHook(() =>
      useWeekTimeblocks({ weekDates, events: [], timezone: 'UTC' }),
    );

    expect(result.current.timeblockPositions).toEqual([]);
    expect(result.current.maxConcurrentTimeblocks).toBe(0);
  });

  it('タイムブロックを日付ごとにグループ化する', () => {
    const mondayTimeblock = createMockTimeblock({
      id: 'monday',
      startDate: new Date('2026-03-30T09:00:00'),
      endDate: new Date('2026-03-30T10:00:00'),
      displayStartDate: new Date('2026-03-30T09:00:00'),
      displayEndDate: new Date('2026-03-30T10:00:00'),
    });
    const wednesdayTimeblock = createMockTimeblock({
      id: 'wednesday',
      startDate: new Date('2026-04-01T14:00:00'),
      endDate: new Date('2026-04-01T15:00:00'),
      displayStartDate: new Date('2026-04-01T14:00:00'),
      displayEndDate: new Date('2026-04-01T15:00:00'),
    });

    const { result } = renderHook(() =>
      useWeekTimeblocks({
        weekDates,
        events: [mondayTimeblock, wednesdayTimeblock],
        timezone: 'UTC',
      }),
    );

    expect(result.current.timeblockPositions).toHaveLength(2);
    // 月曜 = dayIndex 0, 水曜 = dayIndex 2
    const mondayPos = result.current.timeblockPositions.find((p) => p.plan.id === 'monday');
    const wedPos = result.current.timeblockPositions.find((p) => p.plan.id === 'wednesday');
    expect(mondayPos?.dayIndex).toBe(0);
    expect(wedPos?.dayIndex).toBe(2);
  });

  it('ユーザーTZの日付キーで週ビューに配置する', () => {
    const tokyoMidnightTimeblock = createMockTimeblock({
      id: 'tokyo-midnight',
      startDate: new Date('2026-03-29T15:30:00.000Z'),
      endDate: new Date('2026-03-29T16:30:00.000Z'),
      displayStartDate: new Date('2026-03-30T00:30:00'),
      displayEndDate: new Date('2026-03-30T01:30:00'),
    });

    const { result } = renderHook(() =>
      useWeekTimeblocks({
        weekDates,
        events: [tokyoMidnightTimeblock],
        timezone: 'Asia/Tokyo',
      }),
    );

    const position = result.current.timeblockPositions.find((p) => p.plan.id === 'tokyo-midnight');
    expect(position?.dayIndex).toBe(0);
    expect(result.current.timeblocksByDate['2026-03-30']).toHaveLength(1);
  });

  it('週の範囲外のタイムブロックは除外される', () => {
    const outsideTimeblock = createMockTimeblock({
      id: 'outside',
      startDate: new Date('2026-04-10T10:00:00'),
      endDate: new Date('2026-04-10T11:00:00'),
      displayStartDate: new Date('2026-04-10T10:00:00'),
      displayEndDate: new Date('2026-04-10T11:00:00'),
    });

    const { result } = renderHook(() =>
      useWeekTimeblocks({
        weekDates,
        events: [outsideTimeblock],
        timezone: 'UTC',
      }),
    );

    expect(result.current.timeblockPositions).toHaveLength(0);
  });

  it('同日の重複タイムブロックで正しい位置が計算される', () => {
    const timeblock1 = createMockTimeblock({
      id: 'e1',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });
    const timeblock2 = createMockTimeblock({
      id: 'e2',
      startDate: new Date('2026-03-30T10:30:00'),
      endDate: new Date('2026-03-30T11:30:00'),
      displayStartDate: new Date('2026-03-30T10:30:00'),
      displayEndDate: new Date('2026-03-30T11:30:00'),
    });

    const { result } = renderHook(() =>
      useWeekTimeblocks({
        weekDates,
        events: [timeblock1, timeblock2],
        timezone: 'UTC',
      }),
    );

    expect(result.current.timeblockPositions).toHaveLength(2);
    expect(result.current.maxConcurrentTimeblocks).toBe(2);
  });

  it('同じ時間帯では予定外記録を planned より前面にする', () => {
    const unplanned = createMockTimeblock({
      id: 'gap-record',
      kind: 'record',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T10:30:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T10:30:00'),
    });
    const planned = createMockTimeblock({
      id: 'planned',
      kind: 'plan',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });

    const { result } = renderHook(() =>
      useWeekTimeblocks({
        weekDates,
        events: [unplanned, planned],
        timezone: 'UTC',
      }),
    );

    const recordPosition = result.current.timeblockPositions.find(
      (p) => p.plan.id === 'gap-record',
    );
    const plannedPosition = result.current.timeblockPositions.find((p) => p.plan.id === 'planned');

    expect(recordPosition?.zIndex).toBeGreaterThan(plannedPosition?.zIndex ?? 0);
  });
});
