import { describe, expect, it } from 'vitest';

import { isTodayInTimezone } from './timezone';

/**
 * isTodayInTimezone の回帰テスト
 *
 * Bug 背景: date-fns の `isToday` はブラウザ ローカル TZ で判定するため、
 * ユーザーが OS TZ と異なる timezone を設定している場合、calendar の
 * 「今日」ハイライトが 1 日ずれる問題があった。
 * 取得・表示の両方を `useUserPreferences.timezone` で揃える。
 */
describe('isTodayInTimezone', () => {
  it('UTC 23:30 を JST から見ると「翌日」が今日', () => {
    // UTC 2026-04-28 23:30 = JST 2026-04-29 08:30
    const now = new Date('2026-04-28T23:30:00Z');
    const candidateUtc = new Date('2026-04-29T00:00:00Z'); // JST で 09:00 (29日)

    expect(isTodayInTimezone(candidateUtc, 'Asia/Tokyo', now)).toBe(true);
    // 28 日始点（UTC midnight）は JST では既に 29 日 09:00 → 28 日キーは false
    expect(isTodayInTimezone(new Date('2026-04-28T00:00:00Z'), 'Asia/Tokyo', now)).toBe(false);
  });

  it('UTC 日付が前日の NY では前日側を今日と判定する', () => {
    const now = new Date('2026-01-15T03:00:00Z');
    const candidate14 = new Date('2026-01-14T18:00:00Z');
    const candidate15 = new Date('2026-01-15T15:00:00Z');

    expect(isTodayInTimezone(candidate14, 'America/New_York', now)).toBe(true);
    expect(isTodayInTimezone(candidate15, 'America/New_York', now)).toBe(false);
  });

  it('DST spring-forward 当日でも今日判定が壊れない (NY 2026-03-08)', () => {
    // 2026-03-08 はアメリカ DST 開始日。UTC 12:00 = EDT 08:00
    const now = new Date('2026-03-08T12:00:00Z');
    const sameDayMorning = new Date('2026-03-08T06:00:00Z'); // EST 01:00 (DST 前)
    const sameDayAfternoon = new Date('2026-03-08T20:00:00Z'); // EDT 16:00 (DST 後)

    expect(isTodayInTimezone(sameDayMorning, 'America/New_York', now)).toBe(true);
    expect(isTodayInTimezone(sameDayAfternoon, 'America/New_York', now)).toBe(true);
  });
});
