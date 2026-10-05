import { describe, expect, it } from 'vitest';

import {
  anchorMinuteToInstant,
  dayEndInstant,
  instantToAnchorMinute,
  instantToDateKey,
  nextDateKey,
} from './plan-template-anchor';

/**
 * DST policy は date-fns-tz の挙動ではなくこの test が契約（#2567）。
 * gap は前方へ送る、fold は早い方、を実 instant で固定する。
 */
describe('anchorMinuteToInstant', () => {
  it.each([
    ['Africa/Casablanca', '2025-02-23', 150, '2025-02-23T01:30:00.000Z'],
    ['America/Anchorage', '2025-11-02', 90, '2025-11-02T09:30:00.000Z'],
  ])(
    '前日の offset が必要な %s の fold でも早い instant を選ぶ',
    (timezone, dateKey, minute, expected) => {
      // 守ること: 時計が戻る日の二重の壁時計時刻では、常に早い instant を選ぶ。
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const early = new Date(expected);
      const late = new Date(early.getTime() + 3_600_000);
      // 独立した Intl で両 instant が同じ壁時計時刻を指すことも確認する。
      expect(formatter.format(early)).toBe(formatter.format(late));
      expect(anchorMinuteToInstant(dateKey, minute, timezone).toISOString()).toBe(expected);
    },
  );

  it.each([
    '2026-02-30',
    '2025-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
  ])('rejects nonexistent Gregorian date %s before normalization', (date) => {
    expect(() => anchorMinuteToInstant(date, 540, 'UTC')).toThrow(RangeError);
    expect(() => nextDateKey(date)).toThrow(RangeError);
  });

  it('preserves a four-digit year below 100 rather than adding 1900', () => {
    expect(anchorMinuteToInstant('0099-01-01', 540, 'UTC').toISOString()).toBe(
      '0099-01-01T09:00:00.000Z',
    );
    expect(nextDateKey('0099-12-31')).toBe('0100-01-01');
  });

  it('accepts the Gregorian century leap day', () => {
    expect(anchorMinuteToInstant('2000-02-29', 540, 'UTC').toISOString()).toBe(
      '2000-02-29T09:00:00.000Z',
    );
    expect(nextDateKey('2000-02-29')).toBe('2000-03-01');
  });

  it('UTC では壁時計がそのまま instant になる', () => {
    expect(anchorMinuteToInstant('2026-09-05', 9 * 60 + 30, 'UTC').toISOString()).toBe(
      '2026-09-05T09:30:00.000Z',
    );
  });

  it('Asia/Tokyo 09:00 → 前日 15:00Z（半端無しの固定 offset）', () => {
    expect(anchorMinuteToInstant('2026-09-05', 9 * 60, 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-05T00:00:00.000Z',
    );
    expect(anchorMinuteToInstant('2026-09-05', 0, 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-04T15:00:00.000Z',
    );
  });

  it('半時間 offset（Asia/Kolkata 14:00 → 08:30Z）', () => {
    expect(anchorMinuteToInstant('2025-01-22', 14 * 60, 'Asia/Kolkata').toISOString()).toBe(
      '2025-01-22T08:30:00.000Z',
    );
  });

  describe('America/New_York 2025-03-09（spring forward、02:00 → 03:00）', () => {
    it('遷移前 01:00 EST → 06:00Z', () => {
      expect(anchorMinuteToInstant('2025-03-09', 60, 'America/New_York').toISOString()).toBe(
        '2025-03-09T06:00:00.000Z',
      );
    });

    it('遷移後 03:00 EDT → 07:00Z', () => {
      expect(anchorMinuteToInstant('2025-03-09', 180, 'America/New_York').toISOString()).toBe(
        '2025-03-09T07:00:00.000Z',
      );
    });

    it('存在しない 02:30 は前方へ送り 03:30 EDT（07:30Z）になる', () => {
      const instant = anchorMinuteToInstant('2025-03-09', 150, 'America/New_York');
      expect(instant.toISOString()).toBe('2025-03-09T07:30:00.000Z');
      expect(instantToAnchorMinute(instant, 'America/New_York')).toBe(210);
    });

    it('gap 内の錨は前方へ送られるので、03:00 台の錨と instant 順が入れ替わりうる（具現化側が並べ直す）', () => {
      const inGap = anchorMinuteToInstant('2025-03-09', 150, 'America/New_York').getTime();
      const afterGap = anchorMinuteToInstant('2025-03-09', 195, 'America/New_York').getTime();
      expect(inGap).toBeGreaterThan(afterGap);
    });

    /**
     * gap の錨を「DST 差分だけ前方へ送る」以上、その差分ちょうど後ろにある錨とは
     * 必ず同じ instant になる。1 時間が消える日にその 1 時間ぶんの並びを置く先は
     * 無いので、これは policy の帰結であって避けられない。具現化側はこの衝突を
     * 検知して適用全体を拒否する（`plan-template-materialize.test.ts`）。
     */
    it('gap 幅ちょうど後ろの錨とは同じ instant になる（消えた 1 時間の行き先が無い）', () => {
      expect(anchorMinuteToInstant('2025-03-09', 150, 'America/New_York').toISOString()).toBe(
        anchorMinuteToInstant('2025-03-09', 210, 'America/New_York').toISOString(),
      );
    });

    /** 真夜中に遷移する TZ では、00:00 と 01:00 という普通の錨が衝突する。 */
    it.each([
      ['America/Santiago', '2022-09-11'],
      ['Asia/Beirut', '2023-03-26'],
    ])('%s %s は 00:00 の錨が 01:00 と同じ instant になる', (timezone, dateKey) => {
      expect(anchorMinuteToInstant(dateKey, 0, timezone).toISOString()).toBe(
        anchorMinuteToInstant(dateKey, 60, timezone).toISOString(),
      );
    });
  });

  describe('America/New_York 2025-11-02（fall back、02:00 → 01:00）', () => {
    it('2 回ある 01:30 は早い方（EDT、05:30Z）を選ぶ', () => {
      expect(anchorMinuteToInstant('2025-11-02', 90, 'America/New_York').toISOString()).toBe(
        '2025-11-02T05:30:00.000Z',
      );
    });

    it('遷移後 02:30 EST → 07:30Z', () => {
      expect(anchorMinuteToInstant('2025-11-02', 150, 'America/New_York').toISOString()).toBe(
        '2025-11-02T07:30:00.000Z',
      );
    });

    it('その日は 25 時間ある（day end は翌日 00:00 EST = 05:00Z）', () => {
      const start = anchorMinuteToInstant('2025-11-02', 0, 'America/New_York');
      const end = dayEndInstant('2025-11-02', 'America/New_York');
      expect(start.toISOString()).toBe('2025-11-02T04:00:00.000Z');
      expect(end.toISOString()).toBe('2025-11-03T05:00:00.000Z');
    });
  });

  it('00:00 と 23:59 の境界', () => {
    expect(anchorMinuteToInstant('2025-01-22', 0, 'America/New_York').toISOString()).toBe(
      '2025-01-22T05:00:00.000Z',
    );
    expect(anchorMinuteToInstant('2025-01-22', 1439, 'America/New_York').toISOString()).toBe(
      '2025-01-23T04:59:00.000Z',
    );
  });

  it('範囲外の anchor / 不正な dateKey は投げる', () => {
    expect(() => anchorMinuteToInstant('2025-01-22', 1440, 'UTC')).toThrow(RangeError);
    expect(() => anchorMinuteToInstant('2025-01-22', -1, 'UTC')).toThrow(RangeError);
    expect(() => anchorMinuteToInstant('2025/01/22', 0, 'UTC')).toThrow(RangeError);
  });

  it('timezone を変えると同じ壁時計へ追従する（保存元 TZ を持たない契約）', () => {
    const tokyo = anchorMinuteToInstant('2026-09-05', 9 * 60, 'Asia/Tokyo');
    const london = anchorMinuteToInstant('2026-09-05', 9 * 60, 'Europe/London');
    expect(instantToAnchorMinute(tokyo, 'Asia/Tokyo')).toBe(540);
    expect(instantToAnchorMinute(london, 'Europe/London')).toBe(540);
    expect(tokyo.getTime()).not.toBe(london.getTime());
  });
});

describe('nextDateKey / instantToDateKey', () => {
  it('月末・年末を越える', () => {
    expect(nextDateKey('2025-01-31')).toBe('2025-02-01');
    expect(nextDateKey('2025-12-31')).toBe('2026-01-01');
    expect(nextDateKey('2024-02-28')).toBe('2024-02-29');
  });

  it('instant を timezone の暦日へ', () => {
    expect(instantToDateKey(new Date('2026-09-04T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-05');
    expect(instantToDateKey(new Date('2026-09-04T16:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-09-04',
    );
  });
});
