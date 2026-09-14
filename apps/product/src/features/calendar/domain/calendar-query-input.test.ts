import { describe, expect, it } from 'vitest';

import { getDateKey } from '@/lib/date';

import { buildCalendarRangeInput, buildTimeblockListInput } from './calendar-query-input';
import { calculateViewDateRange } from './view-range';

describe('buildCalendarRangeInput', () => {
  it('Asia/Tokyo の日境界を UTC instant にする（暦日の 00:00Z 扱いにしない）', () => {
    expect(
      buildCalendarRangeInput({
        viewType: 'day',
        anchorDateKey: '2026-09-14',
        timezone: 'Asia/Tokyo',
        weekStartsOn: 1,
        showWeekends: true,
      }),
    ).toEqual({
      startDate: '2026-09-13T15:00:00.000Z',
      endDate: '2026-09-14T14:59:59.999Z',
    });
  });

  it('負オフセットの America/Los_Angeles でも基準日がずれない', () => {
    expect(
      buildCalendarRangeInput({
        viewType: 'day',
        anchorDateKey: '2026-04-20',
        timezone: 'America/Los_Angeles',
        weekStartsOn: 1,
        showWeekends: true,
      }),
    ).toEqual({
      startDate: '2026-04-20T07:00:00.000Z',
      endDate: '2026-04-21T06:59:59.999Z',
    });
  });

  it('DST 開始日（Europe/London 2026-03-29）は開始が GMT、終了が BST の境界になる', () => {
    expect(
      buildCalendarRangeInput({
        viewType: 'day',
        anchorDateKey: '2026-03-29',
        timezone: 'Europe/London',
        weekStartsOn: 1,
        showWeekends: true,
      }),
    ).toEqual({
      startDate: '2026-03-29T00:00:00.000Z',
      endDate: '2026-03-29T22:59:59.999Z',
    });
  });

  it.each([
    [0, '2026-09-13T00:00:00.000Z', '2026-09-19T23:59:59.999Z'],
    [1, '2026-09-14T00:00:00.000Z', '2026-09-20T23:59:59.999Z'],
    [6, '2026-09-12T00:00:00.000Z', '2026-09-18T23:59:59.999Z'],
  ] as const)('weekStartsOn=%s の週範囲を反映する', (weekStartsOn, startDate, endDate) => {
    expect(
      buildCalendarRangeInput({
        viewType: 'week',
        anchorDateKey: '2026-09-14',
        timezone: 'UTC',
        weekStartsOn,
        showWeekends: true,
      }),
    ).toEqual({ startDate, endDate });
  });

  it('週末非表示の 5day は表示列と同じ営業日範囲になる', () => {
    expect(
      buildCalendarRangeInput({
        viewType: '5day',
        anchorDateKey: '2026-09-18',
        timezone: 'UTC',
        weekStartsOn: 1,
        showWeekends: false,
      }),
    ).toEqual({
      startDate: '2026-09-16T00:00:00.000Z',
      endDate: '2026-09-22T23:59:59.999Z',
    });
  });

  it('yyyy-MM-dd 以外の基準日は受け付けない', () => {
    expect(() =>
      buildCalendarRangeInput({
        viewType: 'day',
        anchorDateKey: '2026-9-14',
        timezone: 'UTC',
        weekStartsOn: 1,
        showWeekends: true,
      }),
    ).toThrow(RangeError);
  });

  // client の表示範囲（currentDate の時刻込みで計算）と query 範囲（日付キーから計算）が
  // 同じ暦日を指すこと。ずれると画面に出る列と取得範囲が食い違う。
  it.each(['day', 'week', '3day', '7day'] as const)(
    '%s: 時刻付き currentDate から求めた表示範囲と同じ暦日を指す',
    (viewType) => {
      const currentDate = new Date(2026, 8, 18, 23, 30, 0, 0);
      for (const showWeekends of [true, false]) {
        const viewRange = calculateViewDateRange(viewType, currentDate, 0, showWeekends);
        const input = buildCalendarRangeInput({
          viewType,
          anchorDateKey: getDateKey(currentDate),
          timezone: 'UTC',
          weekStartsOn: 0,
          showWeekends,
        });
        expect(input.startDate.slice(0, 10)).toBe(getDateKey(viewRange.start));
        expect(input.endDate.slice(0, 10)).toBe(getDateKey(viewRange.end));
      }
    },
  );
});

describe('buildTimeblockListInput', () => {
  it('並び順だけを足し、limit を付けない', () => {
    const input = buildTimeblockListInput({
      viewType: 'day',
      anchorDateKey: '2026-09-14',
      timezone: 'UTC',
      weekStartsOn: 1,
      showWeekends: true,
    });
    expect(input).toEqual({
      startDate: '2026-09-14T00:00:00.000Z',
      endDate: '2026-09-14T23:59:59.999Z',
      sortBy: 'start_at',
      sortOrder: 'asc',
    });
    expect(input).not.toHaveProperty('limit');
  });
});

describe('既定値の server / client 一致', () => {
  it('row の無い user の既定値が client の fallback と同じ', async () => {
    const { DEFAULT_SHOW_WEEKENDS, DEFAULT_WEEK_STARTS_ON } =
      await import('./calendar-query-input');
    const { toUserPreferences } = await import('@/lib/hooks/useUserPreferences');
    const { toCalendarSettings } = await import('../hooks/useCalendarSettings');

    expect(toUserPreferences(undefined).weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
    expect(toCalendarSettings(undefined).showWeekends).toBe(DEFAULT_SHOW_WEEKENDS);
  });
});
