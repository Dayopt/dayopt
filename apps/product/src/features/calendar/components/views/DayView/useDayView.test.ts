import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (settings: { timezone: string }) => unknown) =>
    selector({ timezone: 'Asia/Tokyo' }),
}));

import type { CalendarDisplayEvent } from '../../../types/calendar.types';
import { useDayView } from './hooks/useDayView';

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

describe('useDayView', () => {
  const baseDate = new Date('2026-03-30');

  it('タイムブロックがない場合は空の配列を返す', () => {
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, timeblocks: [], timezone: 'Asia/Tokyo' }),
    );

    expect(result.current.dayTimeblocks).toEqual([]);
    expect(result.current.timeblockStyles).toEqual({});
  });

  it('指定日のタイムブロックのみをフィルタする', () => {
    const todayTimeblock = createMockTimeblock({
      id: 'today',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });
    const tomorrowTimeblock = createMockTimeblock({
      id: 'tomorrow',
      startDate: new Date('2026-03-31T10:00:00'),
      endDate: new Date('2026-03-31T11:00:00'),
      displayStartDate: new Date('2026-03-31T10:00:00'),
      displayEndDate: new Date('2026-03-31T11:00:00'),
    });

    const { result } = renderHook(() =>
      useDayView({
        date: baseDate,
        timeblocks: [todayTimeblock, tomorrowTimeblock],
        timezone: 'UTC',
      }),
    );

    expect(result.current.dayTimeblocks).toHaveLength(1);
    expect(result.current.dayTimeblocks[0]?.id).toBe('today');
  });

  it('タイムブロックのCSSスタイルが計算される', () => {
    const timeblock = createMockTimeblock({ id: 'styled' });
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, timeblocks: [timeblock], timezone: 'UTC' }),
    );

    const styles = result.current.timeblockStyles;
    expect(styles['styled']).toBeDefined();
    expect(styles['styled']?.position).toBe('absolute');
    expect(styles['styled']?.top).toBeDefined();
    expect(styles['styled']?.height).toBeDefined();
  });

  it('timeSlotsが生成される', () => {
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, timeblocks: [], timezone: 'UTC' }),
    );

    // 24時間 × 4 (15分刻み) = 96スロット
    expect(result.current.timeSlots.length).toBe(96);
    expect(result.current.timeSlots[0]?.hour).toBe(0);
    expect(result.current.timeSlots[0]?.minute).toBe(0);
  });

  it('重複タイムブロックに正しい幅が設定される', () => {
    const timeblock1 = createMockTimeblock({
      id: 'overlap-1',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });
    const timeblock2 = createMockTimeblock({
      id: 'overlap-2',
      startDate: new Date('2026-03-30T10:30:00'),
      endDate: new Date('2026-03-30T11:30:00'),
      displayStartDate: new Date('2026-03-30T10:30:00'),
      displayEndDate: new Date('2026-03-30T11:30:00'),
    });

    const { result } = renderHook(() =>
      useDayView({
        date: baseDate,
        timeblocks: [timeblock1, timeblock2],
        timezone: 'UTC',
      }),
    );

    // 重複するので幅が50%ずつ
    const style1 = result.current.timeblockStyles['overlap-1'];
    const style2 = result.current.timeblockStyles['overlap-2'];
    expect(style1).toBeDefined();
    expect(style2).toBeDefined();
    expect(parseFloat(style1?.width?.toString() ?? '100')).toBe(50);
    expect(parseFloat(style2?.width?.toString() ?? '100')).toBe(50);
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
      useDayView({
        date: baseDate,
        timeblocks: [unplanned, planned],
        timezone: 'UTC',
      }),
    );

    const recordZIndex = Number(result.current.timeblockStyles['gap-record']?.zIndex);
    const plannedZIndex = Number(result.current.timeblockStyles.planned?.zIndex);

    expect(recordZIndex).toBeGreaterThan(plannedZIndex);
  });
});
