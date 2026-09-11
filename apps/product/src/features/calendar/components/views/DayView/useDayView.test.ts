import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (settings: { timezone: string }) => unknown) =>
    selector({ timezone: 'Asia/Tokyo' }),
}));

import type { CalendarDisplayEvent } from '../../../types/calendar.types';
import { useDayView } from './hooks/useDayView';

const createMockEntry = (overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent => ({
  id: `entry-${Math.random().toString(36).slice(2)}`,
  title: 'Test Entry',
  startDate: new Date('2026-03-30T10:00:00'),
  endDate: new Date('2026-03-30T11:00:00'),
  displayStartDate: new Date('2026-03-30T10:00:00'),
  displayEndDate: new Date('2026-03-30T11:00:00'),
  status: 'open',
  color: 'blue',
  duration: 60,
  isMultiDay: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  version: '2026-07-15T00:00:00.000000Z',
  ...overrides,
});

describe('useDayView', () => {
  const baseDate = new Date('2026-03-30');

  it('エントリがない場合は空の配列を返す', () => {
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, entries: [], timezone: 'Asia/Tokyo' }),
    );

    expect(result.current.dayEntries).toEqual([]);
    expect(result.current.timeblockStyles).toEqual({});
  });

  it('指定日のエントリのみをフィルタする', () => {
    const todayEntry = createMockEntry({
      id: 'today',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });
    const tomorrowEntry = createMockEntry({
      id: 'tomorrow',
      startDate: new Date('2026-03-31T10:00:00'),
      endDate: new Date('2026-03-31T11:00:00'),
      displayStartDate: new Date('2026-03-31T10:00:00'),
      displayEndDate: new Date('2026-03-31T11:00:00'),
    });

    const { result } = renderHook(() =>
      useDayView({
        date: baseDate,
        entries: [todayEntry, tomorrowEntry],
        timezone: 'UTC',
      }),
    );

    expect(result.current.dayEntries).toHaveLength(1);
    expect(result.current.dayEntries[0]?.id).toBe('today');
  });

  it('エントリのCSSスタイルが計算される', () => {
    const entry = createMockEntry({ id: 'styled' });
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, entries: [entry], timezone: 'UTC' }),
    );

    const styles = result.current.timeblockStyles;
    expect(styles['styled']).toBeDefined();
    expect(styles['styled']?.position).toBe('absolute');
    expect(styles['styled']?.top).toBeDefined();
    expect(styles['styled']?.height).toBeDefined();
  });

  it('timeSlotsが生成される', () => {
    const { result } = renderHook(() =>
      useDayView({ date: baseDate, entries: [], timezone: 'UTC' }),
    );

    // 24時間 × 4 (15分刻み) = 96スロット
    expect(result.current.timeSlots.length).toBe(96);
    expect(result.current.timeSlots[0]?.hour).toBe(0);
    expect(result.current.timeSlots[0]?.minute).toBe(0);
  });

  it('重複エントリに正しい幅が設定される', () => {
    const entry1 = createMockEntry({
      id: 'overlap-1',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T11:00:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T11:00:00'),
    });
    const entry2 = createMockEntry({
      id: 'overlap-2',
      startDate: new Date('2026-03-30T10:30:00'),
      endDate: new Date('2026-03-30T11:30:00'),
      displayStartDate: new Date('2026-03-30T10:30:00'),
      displayEndDate: new Date('2026-03-30T11:30:00'),
    });

    const { result } = renderHook(() =>
      useDayView({
        date: baseDate,
        entries: [entry1, entry2],
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
    const unplanned = createMockEntry({
      id: 'gap-record',
      kind: 'record',
      startDate: new Date('2026-03-30T10:00:00'),
      endDate: new Date('2026-03-30T10:30:00'),
      displayStartDate: new Date('2026-03-30T10:00:00'),
      displayEndDate: new Date('2026-03-30T10:30:00'),
    });
    const planned = createMockEntry({
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
        entries: [unplanned, planned],
        timezone: 'UTC',
      }),
    );

    const recordZIndex = Number(result.current.timeblockStyles['gap-record']?.zIndex);
    const plannedZIndex = Number(result.current.timeblockStyles.planned?.zIndex);

    expect(recordZIndex).toBeGreaterThan(plannedZIndex);
  });
});
