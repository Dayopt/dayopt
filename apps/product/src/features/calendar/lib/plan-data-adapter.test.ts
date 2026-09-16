import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarEvent } from '@/features/timeblock';

vi.mock('@/lib/date/timezone', () => ({
  // テスト時はシステム TZ 依存を排除し、入力 Date に 1h 加算した別インスタンスを返す
  // （「変換が呼ばれたか」「左辺/右辺それぞれに適用されたか」を検証できる粒度）
  convertToTimezone: vi.fn((date: Date) => new Date(date.getTime() + 60 * 60 * 1000)),
}));

const { applyTimezoneToDisplayDates } = await import('./plan-data-adapter');
const { convertToTimezone } = await import('@/lib/date/timezone');

const TZ = 'Asia/Tokyo';

function makeEvent(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  const start = new Date('2026-04-27T01:00:00.000Z');
  const end = new Date('2026-04-27T02:00:00.000Z');
  return {
    title: 'Sample',
    startDate: start,
    endDate: end,
    color: '',
    version: '2026-07-15T00:00:00.000000Z',
    displayStartDate: start,
    displayEndDate: end,
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
    ...overrides,
  };
}

describe('applyTimezoneToDisplayDates', () => {
  beforeEach(() => {
    vi.mocked(convertToTimezone).mockClear();
  });

  it('startDate が null の場合は早期 return（変換を呼ばない）', () => {
    const event = makeEvent({ id: 'e1', startDate: null });
    const result = applyTimezoneToDisplayDates(event, TZ);

    expect(result).toBe(event);
    expect(convertToTimezone).not.toHaveBeenCalled();
  });

  it('startDate / endDate を convertToTimezone で変換して displayStart/EndDate に反映する', () => {
    const event = makeEvent({ id: 'e1' });
    const result = applyTimezoneToDisplayDates(event, TZ);

    expect(convertToTimezone).toHaveBeenCalledTimes(2);
    expect(convertToTimezone).toHaveBeenNthCalledWith(1, event.startDate, TZ);
    expect(convertToTimezone).toHaveBeenNthCalledWith(2, event.endDate, TZ);

    // mock では入力 +1h を返す
    expect(result.displayStartDate.toISOString()).toBe('2026-04-27T02:00:00.000Z');
    expect(result.displayEndDate.toISOString()).toBe('2026-04-27T03:00:00.000Z');
  });

  it('endDate が null の場合は既存の displayEndDate を保持し convertToTimezone を 1 度のみ呼ぶ', () => {
    const fallback = new Date('2026-04-27T05:00:00.000Z');
    const event = makeEvent({ id: 'e1', endDate: null, displayEndDate: fallback });

    const result = applyTimezoneToDisplayDates(event, TZ);

    expect(result.displayEndDate).toBe(fallback);
    // startDate のみ変換される
    expect(convertToTimezone).toHaveBeenCalledTimes(1);
    expect(convertToTimezone).toHaveBeenCalledWith(event.startDate, TZ);
  });

  it('元の event を mutate しない（新しいオブジェクトを返す）', () => {
    const event = makeEvent({ id: 'e1' });
    const originalDisplayStart = event.displayStartDate;

    const result = applyTimezoneToDisplayDates(event, TZ);

    expect(result).not.toBe(event);
    expect(event.displayStartDate).toBe(originalDisplayStart);
  });

  it('startDate 以外のフィールド（title / kind 等）はそのままコピーされる', () => {
    const event = makeEvent({ id: 'e1', title: 'Coding', kind: 'record', duration: 90 });
    const result = applyTimezoneToDisplayDates(event, TZ);

    expect(result.id).toBe('e1');
    expect(result.title).toBe('Coding');
    expect(result.kind).toBe('record');
    expect(result.duration).toBe(90);
  });
});
