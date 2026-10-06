import { describe, expect, it } from 'vitest';

import {
  buildTimeblockSearchResultPath,
  resolveTimeblockSearchResultDate,
} from './timeblock-search-path';

describe('buildTimeblockSearchResultPath', () => {
  it('ユーザーTZの日付とPlanインスペクターをURLへ含める', () => {
    expect(
      buildTimeblockSearchResultPath({
        locale: 'ja',
        startAt: '2026-07-14T15:30:00.000Z',
        timezone: 'Asia/Tokyo',
        timeblockId: 'plan-1',
        kind: 'plan',
      }),
    ).toBe('/ja/?date=2026-07-15&view=day&timeblock=plan%3Aplan-1');
  });

  it('Recordの既存URL契約を使う', () => {
    expect(
      buildTimeblockSearchResultPath({
        locale: 'en',
        startAt: '2026-07-15T02:00:00.000Z',
        timezone: 'America/New_York',
        timeblockId: 'record-1',
        kind: 'record',
      }),
    ).toBe('/?date=2026-07-14&view=day&timeblock=record%3Arecord-1');
  });
});

describe('resolveTimeblockSearchResultDate', () => {
  it('Calendar timezoneの日付をローカル正午として返す', () => {
    const result = resolveTimeblockSearchResultDate('2026-07-14T23:30:00.000Z', 'Asia/Tokyo');

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(6);
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(12);
  });
});
