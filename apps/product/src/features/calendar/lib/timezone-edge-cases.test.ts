/**
 * タイムゾーン遷移・DSTエッジケーステスト
 *
 * date-fns-tz の convertToTimezone を通した場合の
 * DST境界での挙動を検証する。
 */

import { describe, expect, it } from 'vitest';

import { convertToTimezone } from '@/lib/date/timezone';

import { layoutTimeblockToVerticalPosition } from './grid';

describe('タイムゾーンエッジケース', () => {
  describe('DST遷移（米国: 3月第2日曜 spring forward）', () => {
    // 2026年3月8日 2:00 AM EST → 3:00 AM EDT (1時間消失)
    it('spring forward当日の時刻変換が正しい', () => {
      // UTC 7:00 = EST 2:00 (DST前) → EDT 3:00 (DST後)
      const utcDate = new Date('2026-03-08T07:00:00Z');
      const nyTime = convertToTimezone(utcDate, 'America/New_York');
      // DST後なのでEDT (UTC-4) → 3:00 AM
      expect(nyTime.getHours()).toBe(3);
    });

    it('spring forward前の時刻は正常', () => {
      // UTC 6:00 = EST 1:00 AM (DST前)
      const utcDate = new Date('2026-03-08T06:00:00Z');
      const nyTime = convertToTimezone(utcDate, 'America/New_York');
      expect(nyTime.getHours()).toBe(1);
    });
  });

  describe('DST遷移（米国: 11月第1日曜 fall back）', () => {
    // 2026年11月1日 2:00 AM EDT → 1:00 AM EST (1時間重複)
    it('fall back後の時刻変換が正しい', () => {
      // UTC 7:00 = EST 2:00 AM (fall back後)
      const utcDate = new Date('2026-11-01T07:00:00Z');
      const nyTime = convertToTimezone(utcDate, 'America/New_York');
      expect(nyTime.getHours()).toBe(2);
    });
  });

  describe('日本時間（DST なし）', () => {
    it('年間を通じてUTC+9', () => {
      const summer = new Date('2026-07-15T00:00:00Z'); // UTC midnight
      const winter = new Date('2026-01-15T00:00:00Z');

      const summerJST = convertToTimezone(summer, 'Asia/Tokyo');
      const winterJST = convertToTimezone(winter, 'Asia/Tokyo');

      expect(summerJST.getHours()).toBe(9);
      expect(winterJST.getHours()).toBe(9);
    });
  });

  describe('位置計算のTZ一貫性', () => {
    it('同じ時刻はTZに関わらず同じY位置を返す', () => {
      // 10:00 AM のタイムブロックは timezone に関わらず同じ top を持つべき
      const hourHeight = 72;
      const start10 = new Date('2026-03-30T10:00:00');
      const end11 = new Date('2026-03-30T11:00:00');

      const pos = layoutTimeblockToVerticalPosition(start10, end11, hourHeight);
      expect(pos.top).toBe(10 * hourHeight); // 10時 × 72px
      expect(pos.height).toBe(hourHeight - 2); // 1時間 - padding
    });

    it('15分タイムブロックは最小高さを保証', () => {
      const start = new Date('2026-03-30T10:00:00');
      const end = new Date('2026-03-30T10:15:00');

      const pos = layoutTimeblockToVerticalPosition(start, end, 72);
      expect(pos.height).toBeGreaterThanOrEqual(14); // MIN_EVENT_HEIGHT
    });
  });
});
