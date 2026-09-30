import { describe, expect, it } from 'vitest';

import {
  distributeToHours,
  distributeToTimeOfDay,
  REPORT_TIME_OF_DAY_BUCKETS,
} from './report-period';

const TOKYO = 'Asia/Tokyo';

describe('時間帯の壁時計位置と実経過時間', () => {
  it.each([
    [
      '終了日の23時',
      '2026-11-02T04:00:00Z',
      '2026-11-02T04:30:00Z',
      'America/New_York',
      { 23: 30 },
    ],
    ['開始日の3時', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z', 'America/New_York', { 3: 30 }],
    ['繰り返す1時', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', 'America/New_York', { 1: 60 }],
    [
      '存在しない2時',
      '2026-03-08T06:30:00Z',
      '2026-03-08T07:30:00Z',
      'America/New_York',
      { 1: 30, 3: 30 },
    ],
    [
      '30分の巻き戻し',
      '2026-04-04T14:45:00Z',
      '2026-04-04T15:15:00Z',
      'Australia/Lord_Howe',
      { 1: 30 },
    ],
    [
      '30分の早送り',
      '2026-10-03T15:15:00Z',
      '2026-10-03T15:45:00Z',
      'Australia/Lord_Howe',
      { 1: 15, 2: 15 },
    ],
    [
      '日境界',
      '2026-11-02T04:30:00Z',
      '2026-11-02T05:30:00Z',
      'America/New_York',
      { 23: 30, 0: 30 },
    ],
    [
      '秒の端数',
      '2026-03-08T06:59:30Z',
      '2026-03-08T07:00:30Z',
      'America/New_York',
      { 1: 0.5, 3: 0.5 },
    ],
  ] as const)(
    '%sは実時間を対応する時計の時間帯に計上する',
    (_name, start, end, timezone, expected) => {
      const hours = distributeToHours(start, end, timezone);
      const expectedHours: number[] = Array.from({ length: 24 }, () => 0);
      for (const [hour, minutes] of Object.entries(expected)) expectedHours[Number(hour)] = minutes;
      expect(hours).toEqual(expectedHours);
      expect(hours.reduce((sum, minutes) => sum + minutes, 0)).toBe(
        (Date.parse(end) - Date.parse(start)) / 60_000,
      );
      const coarse = distributeToTimeOfDay(start, end, timezone);
      expect(coarse).toEqual(
        REPORT_TIME_OF_DAY_BUCKETS.map((bucket) =>
          hours
            .slice(bucket.startMinute / 60, bucket.endMinute / 60)
            .reduce((sum, minutes) => sum + minutes, 0),
        ),
      );
    },
  );

  it.each([
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 2, 0, 1380],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 1, 120, 1500],
  ] as const)(
    'DSTの日全体 %s も実時間を過不足なく計上する',
    (start, end, changedHour, minutes, total) => {
      const hours = distributeToHours(start, end, 'America/New_York');
      expect(hours).toEqual(
        Array.from({ length: 24 }, (_, hour) => (hour === changedHour ? minutes : 60)),
      );
      expect(
        distributeToTimeOfDay(start, end, 'America/New_York').reduce(
          (sum, value) => sum + value,
          0,
        ),
      ).toBe(total);
    },
  );
});

/** バケット名 → index（配列順に依存した assert を書かないため）。 */
const INDEX = Object.fromEntries(
  REPORT_TIME_OF_DAY_BUCKETS.map((bucket, index) => [bucket.key, index]),
) as Record<(typeof REPORT_TIME_OF_DAY_BUCKETS)[number]['key'], number>;

/** JST の壁時計時刻を UTC ISO へ。 */
function jst(day: string, time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const utcHour = (hour ?? 0) - 9;
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCHours(utcHour, minute ?? 0, 0, 0);
  return date.toISOString();
}

describe('distributeToTimeOfDay', () => {
  it('1 つのバケットに収まる記録はそこへ全部入る', () => {
    const totals = distributeToTimeOfDay(
      jst('2026-09-02', '10:00'),
      jst('2026-09-02', '11:30'),
      TOKYO,
    );

    expect(totals[INDEX.lateMorning]).toBe(90);
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(90);
  });

  /** 仕様 §6-4。バケット境界（12:00）を跨ぐ記録は按分され、片方へ寄らない。 */
  it('バケットを跨ぐ記録を按分する', () => {
    const totals = distributeToTimeOfDay(
      jst('2026-09-02', '11:00'),
      jst('2026-09-02', '13:00'),
      TOKYO,
    );

    expect(totals[INDEX.lateMorning]).toBe(60);
    expect(totals[INDEX.midday]).toBe(60);
  });

  /** 0 時またぎは日境界で分割してから按分する（夜 → 深夜）。 */
  it('0 時をまたぐ記録を夜と深夜へ分ける', () => {
    const totals = distributeToTimeOfDay(
      jst('2026-09-02', '23:30'),
      jst('2026-09-03', '01:00'),
      TOKYO,
    );

    expect(totals[INDEX.evening]).toBe(30);
    expect(totals[INDEX.night]).toBe(60);
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(90);
  });

  /** timezone で切る。UTC のまま切ると JST 早朝の記録が前日の夜へ落ちる。 */
  it('ユーザーの timezone の壁時計で位置を決める', () => {
    // JST 06:00–07:00（UTC では前日 21:00–22:00）
    const totals = distributeToTimeOfDay(
      jst('2026-09-02', '06:00'),
      jst('2026-09-02', '07:00'),
      TOKYO,
    );

    expect(totals[INDEX.morning]).toBe(60);
    expect(totals[INDEX.evening]).toBe(0);
  });

  it('複数日にまたがる記録も日ごとに分けて按分する', () => {
    const totals = distributeToTimeOfDay(
      jst('2026-09-02', '22:00'),
      jst('2026-09-04', '02:00'),
      TOKYO,
    );

    // 2 日ぶんの深夜（各 300 分）+ 初日の夜 120 分 + 中日の各バケット
    expect(totals[INDEX.night]).toBe(300 + 120);
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(28 * 60);
  });

  it('長さ 0 と逆転した区間は 0 を返す', () => {
    const same = distributeToTimeOfDay(
      jst('2026-09-02', '10:00'),
      jst('2026-09-02', '10:00'),
      TOKYO,
    );
    const reversed = distributeToTimeOfDay(
      jst('2026-09-02', '11:00'),
      jst('2026-09-02', '10:00'),
      TOKYO,
    );

    expect(same.every((value) => value === 0)).toBe(true);
    expect(reversed.every((value) => value === 0)).toBe(true);
  });
});
