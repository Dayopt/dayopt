import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCalendarRangeInput, buildTimeblockListInput } from '@/features/calendar';

const mocks = vi.hoisted(() => ({
  requestCalendarDate: {
    dateKey: '2026-09-15',
    timezone: 'Asia/Tokyo',
    hasBrowserTimezone: true,
  },
  settings: vi.fn(),
  plansPrefetch: vi.fn(),
  recordsPrefetch: vi.fn(),
  listEventsPrefetch: vi.fn(),
  activityStatsPrefetch: vi.fn(),
}));

vi.mock('@/lib/server/request-calendar-date', () => ({
  getRequestCalendarDate: vi.fn(async () => mocks.requestCalendarDate),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/trpc/server', () => ({
  createServerHelpers: vi.fn(async () => ({
    queryClient: {},
    userSettings: { get: { fetch: mocks.settings } },
    plans: { list: { prefetch: mocks.plansPrefetch } },
    records: { list: { prefetch: mocks.recordsPrefetch } },
    externalCalendar: { listEvents: { prefetch: mocks.listEventsPrefetch } },
    statistics: { getActivityStats: { prefetch: mocks.activityStatsPrefetch } },
  })),
  dehydrate: vi.fn(() => ({ queries: [], mutations: [] })),
}));

import { prefetchCalendarData } from './calendar-prefetch';

describe('prefetchCalendarData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.requestCalendarDate = {
      dateKey: '2026-09-15',
      timezone: 'Asia/Tokyo',
      hasBrowserTimezone: true,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('client の useCalendarData と同じ builder・同じ設定値で plans / records / ghost を先読みする', async () => {
    // JST では 2026-09-15 の朝、UTC ではまだ 09-14
    vi.setSystemTime(new Date('2026-09-14T23:30:00.000Z'));
    mocks.settings.mockResolvedValue({
      timezone: 'Asia/Tokyo',
      weekStartsOn: 0,
      showWeekends: false,
    });

    await prefetchCalendarData('week', undefined);

    const expectedOptions = {
      viewType: 'week' as const,
      anchorDateKey: '2026-09-15',
      timezone: 'Asia/Tokyo',
      weekStartsOn: 0 as const,
      showWeekends: false,
    };
    const expectedListInput = buildTimeblockListInput(expectedOptions);
    expect(mocks.plansPrefetch).toHaveBeenCalledWith(expectedListInput);
    expect(mocks.recordsPrefetch).toHaveBeenCalledWith(expectedListInput);
    expect(mocks.listEventsPrefetch).toHaveBeenCalledWith(buildCalendarRangeInput(expectedOptions));
    // 旧実装の不一致 3 点（偽 UTC 境界・週開始 1 固定・limit）が戻っていないこと。
    // 日曜始まり + 週末非表示なので 09-14(月)〜09-18(金) の JST 境界になる
    expect(expectedListInput).toEqual({
      startDate: '2026-09-13T15:00:00.000Z',
      endDate: '2026-09-18T14:59:59.999Z',
      sortBy: 'start_at',
      sortOrder: 'asc',
    });
    expect(mocks.plansPrefetch.mock.calls[0]?.[0]).not.toHaveProperty('limit');
  });

  it('?date= は TZ 変換を掛けず、その暦日を基準にする（負オフセット TZ で前日にずれない）', async () => {
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'));
    mocks.settings.mockResolvedValue({
      timezone: 'America/Los_Angeles',
      weekStartsOn: 1,
      showWeekends: true,
    });

    await prefetchCalendarData('day', '2026-04-20');

    expect(mocks.plansPrefetch).toHaveBeenCalledWith({
      startDate: '2026-04-20T07:00:00.000Z',
      endDate: '2026-04-21T06:59:59.999Z',
      sortBy: 'start_at',
      sortOrder: 'asc',
    });
  });

  it('不正な ?date= は client と同じく今日（ブラウザ TZ の暦日）に倒す', async () => {
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'));
    mocks.requestCalendarDate = {
      dateKey: '2026-09-14',
      timezone: 'UTC',
      hasBrowserTimezone: true,
    };
    mocks.settings.mockResolvedValue({ timezone: 'UTC', weekStartsOn: 1, showWeekends: true });

    await prefetchCalendarData('day', '2026-13-01');

    expect(mocks.plansPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-09-14T00:00:00.000Z' }),
    );
  });

  it('user_settings の row が無い新規ユーザーは client の既定（browser TZ / 月曜 / 週末表示）に合わせる', async () => {
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'));
    mocks.requestCalendarDate = {
      dateKey: '2026-09-14',
      timezone: 'Europe/Berlin',
      hasBrowserTimezone: true,
    };
    mocks.settings.mockResolvedValue(null);

    await prefetchCalendarData('week', '2026-09-16');

    expect(mocks.plansPrefetch).toHaveBeenCalledWith(
      buildTimeblockListInput({
        viewType: 'week',
        anchorDateKey: '2026-09-16',
        timezone: 'Europe/Berlin',
        weekStartsOn: 1,
        showWeekends: true,
      }),
    );
  });

  it('settings を取得できない時は calendar 範囲を先読みしない（曖昧な既定値で key を外さない）', async () => {
    mocks.settings.mockRejectedValue(new Error('UNAUTHORIZED'));

    const result = await prefetchCalendarData('week', undefined);

    expect(mocks.plansPrefetch).not.toHaveBeenCalled();
    expect(mocks.recordsPrefetch).not.toHaveBeenCalled();
    expect(result.dehydratedState).toEqual({ queries: [], mutations: [] });
  });
});
