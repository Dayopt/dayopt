import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ headers: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: (key: string) => mocks.headers.get(key) ?? null })),
}));

import { getRequestCalendarDate } from './request-calendar-date';

describe('getRequestCalendarDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.headers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the browser timezone wall date', async () => {
    vi.setSystemTime(new Date('2026-09-17T23:30:00.000Z'));
    mocks.headers.set('x-user-timezone', 'Asia/Tokyo');

    await expect(getRequestCalendarDate()).resolves.toEqual({
      dateKey: '2026-09-18',
      timezone: 'Asia/Tokyo',
      hasBrowserTimezone: true,
    });
  });
});
