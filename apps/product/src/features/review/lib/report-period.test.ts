import { describe, expect, it } from 'vitest';

import {
  clipMinutes,
  distributeToBuckets,
  isReportGranularity,
  resolvePreviousReportRange,
  resolveReportRange,
  shiftReportAnchor,
  todayReportAnchor,
} from './report-period';

const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';
const NEW_YORK = 'America/New_York';

/** 次の期間。本体からは消えた helper の代わりに、anchor を 1 期間ずらして同じ関数で解く。 */
function nextRange(anchorDate: string, granularity: 'week' | 'month' | 'year') {
  return resolveReportRange(shiftReportAnchor(anchorDate, granularity, 1), granularity, TOKYO, 1);
}

describe('resolveReportRange - 週', () => {
  it('月曜始まりで水曜を含む週を返す', () => {
    // 2026-09-02 は水曜。月曜始まりなら 08-31（月）〜 09-07（月、含まない）
    const range = resolveReportRange('2026-09-02', 'week', TOKYO, 1);

    expect(range.startAt).toBe('2026-08-30T15:00:00.000Z'); // JST 08-31 00:00
    expect(range.endAt).toBe('2026-09-06T15:00:00.000Z'); // JST 09-07 00:00
    expect(range.lengthMinutes).toBe(10080);
    expect(range.buckets).toHaveLength(7);
    expect(range.buckets[0]?.key).toBe('2026-08-31');
    expect(range.buckets[6]?.key).toBe('2026-09-06');
  });

  it('日曜始まりで週境界がずれる', () => {
    const range = resolveReportRange('2026-09-02', 'week', TOKYO, 0);

    expect(range.buckets[0]?.key).toBe('2026-08-30');
    expect(range.buckets[6]?.key).toBe('2026-09-05');
  });

  it('土曜始まりで週境界がずれる', () => {
    const range = resolveReportRange('2026-09-02', 'week', TOKYO, 6);

    expect(range.buckets[0]?.key).toBe('2026-08-29');
    expect(range.buckets[6]?.key).toBe('2026-09-04');
  });

  it('timezone ごとに UTC の瞬間が変わる', () => {
    const tokyo = resolveReportRange('2026-09-02', 'week', TOKYO, 1);
    const utc = resolveReportRange('2026-09-02', 'week', UTC, 1);
    const newYork = resolveReportRange('2026-09-02', 'week', NEW_YORK, 1);

    expect(tokyo.startAt).toBe('2026-08-30T15:00:00.000Z');
    expect(utc.startAt).toBe('2026-08-31T00:00:00.000Z');
    // EDT（UTC-4）の 08-31 00:00
    expect(newYork.startAt).toBe('2026-08-31T04:00:00.000Z');

    // 壁時計の列見出しは timezone によらず同じ
    expect(tokyo.buckets.map((b) => b.key)).toEqual(utc.buckets.map((b) => b.key));
    expect(tokyo.buckets.map((b) => b.key)).toEqual(newYork.buckets.map((b) => b.key));
  });

  it('列が半開区間で隙間なく連なる', () => {
    const range = resolveReportRange('2026-09-02', 'week', TOKYO, 1);

    expect(range.buckets[0]?.startAt).toBe(range.startAt);
    expect(range.buckets[6]?.endAt).toBe(range.endAt);
    for (let index = 0; index < range.buckets.length - 1; index += 1) {
      expect(range.buckets[index]?.endAt).toBe(range.buckets[index + 1]?.startAt);
    }
  });

  it('隣り合う週の間に隙間が無い（1ms の穴を作らない）', () => {
    const current = resolveReportRange('2026-09-02', 'week', TOKYO, 1);
    const next = nextRange('2026-09-02', 'week');

    expect(current.endAt).toBe(next.startAt);
  });
});

describe('resolveReportRange - 月', () => {
  it('暦月の境界を返す', () => {
    const range = resolveReportRange('2026-09-15', 'month', TOKYO, 1);

    expect(range.startAt).toBe('2026-08-31T15:00:00.000Z'); // JST 09-01 00:00
    expect(range.endAt).toBe('2026-09-30T15:00:00.000Z'); // JST 10-01 00:00
    expect(range.lengthMinutes).toBe(30 * 1440);
  });

  it('うるう年の 2 月は 29 日ぶんの分母になる', () => {
    const leap = resolveReportRange('2028-02-10', 'month', UTC, 1);
    const nonLeap = resolveReportRange('2026-02-10', 'month', UTC, 1);

    expect(leap.lengthMinutes).toBe(29 * 1440);
    expect(nonLeap.lengthMinutes).toBe(28 * 1440);
  });

  it('週列が月内で閉じ、前後の月へはみ出さない', () => {
    // 2026-09-01 は火曜。月曜始まりなら先頭列は 09-01〜09-07 の 6 日ぶん
    const range = resolveReportRange('2026-09-15', 'month', TOKYO, 1);

    expect(range.buckets[0]?.key).toBe('2026-09-01');
    expect(range.buckets[0]?.startAt).toBe(range.startAt);
    expect(range.buckets[range.buckets.length - 1]?.endAt).toBe(range.endAt);

    for (let index = 0; index < range.buckets.length - 1; index += 1) {
      expect(range.buckets[index]?.endAt).toBe(range.buckets[index + 1]?.startAt);
    }
  });

  it('週の開始曜日で月の列数が変わる', () => {
    const monday = resolveReportRange('2026-09-15', 'month', TOKYO, 1);
    const sunday = resolveReportRange('2026-09-15', 'month', TOKYO, 0);

    expect(monday.buckets.length).toBeGreaterThanOrEqual(4);
    expect(monday.buckets.length).toBeLessThanOrEqual(6);
    expect(sunday.buckets.length).toBeGreaterThanOrEqual(4);
    expect(sunday.buckets.length).toBeLessThanOrEqual(6);
  });
});

describe('resolveReportRange - 年', () => {
  it('暦年の境界と 12 列を返す', () => {
    const range = resolveReportRange('2026-06-15', 'year', TOKYO, 1);

    expect(range.startAt).toBe('2025-12-31T15:00:00.000Z'); // JST 2026-01-01 00:00
    expect(range.endAt).toBe('2026-12-31T15:00:00.000Z'); // JST 2027-01-01 00:00
    expect(range.lengthMinutes).toBe(365 * 1440);
    expect(range.buckets).toHaveLength(12);
    expect(range.buckets[0]?.key).toBe('2026-01');
    expect(range.buckets[11]?.key).toBe('2026-12');
  });

  it('うるう年は 366 日ぶんの分母になる', () => {
    expect(resolveReportRange('2028-06-15', 'year', UTC, 1).lengthMinutes).toBe(366 * 1440);
  });
});

describe('DST', () => {
  it('DST 開始週でも lengthMinutes は 10080 のまま（意図的に無視する）', () => {
    // 2026-03-08（日）は America/New_York の DST 開始日。月曜始まりだと 03-02 の週に入る
    const range = resolveReportRange('2026-03-05', 'week', NEW_YORK, 1);

    expect(range.lengthMinutes).toBe(10080);
    // 実経過時間は 167 時間で、公称値とずれる
    const actualMinutes = (Date.parse(range.endAt) - Date.parse(range.startAt)) / 60000;
    expect(actualMinutes).toBe(167 * 60);
  });

  it('DST をまたいでも列が隙間なく連なる', () => {
    const range = resolveReportRange('2026-03-05', 'week', NEW_YORK, 1);

    for (let index = 0; index < range.buckets.length - 1; index += 1) {
      expect(range.buckets[index]?.endAt).toBe(range.buckets[index + 1]?.startAt);
    }
    expect(range.buckets[6]?.endAt).toBe(range.endAt);
  });
});

describe('shiftReportAnchor', () => {
  it('粒度ごとに 1 期間ずつ動く', () => {
    expect(shiftReportAnchor('2026-09-02', 'week', 1)).toBe('2026-09-09');
    expect(shiftReportAnchor('2026-09-02', 'week', -1)).toBe('2026-08-26');
    expect(shiftReportAnchor('2026-09-15', 'month', 1)).toBe('2026-10-15');
    expect(shiftReportAnchor('2026-09-15', 'month', -1)).toBe('2026-08-15');
    expect(shiftReportAnchor('2026-09-15', 'year', 1)).toBe('2027-09-15');
    expect(shiftReportAnchor('2026-09-15', 'year', -1)).toBe('2025-09-15');
  });

  it('月末をまたぐときに日付が溢れない', () => {
    // 1/31 の翌月は 2/28（date-fns の clamp）
    expect(shiftReportAnchor('2026-01-31', 'month', 1)).toBe('2026-02-28');
  });
});

describe('resolvePreviousReportRange / 次の期間', () => {
  it('前後の期間が現在の期間と接する', () => {
    const previous = resolvePreviousReportRange('2026-09-02', 'week', TOKYO, 1);
    const current = resolveReportRange('2026-09-02', 'week', TOKYO, 1);
    const next = nextRange('2026-09-02', 'week');

    expect(previous.endAt).toBe(current.startAt);
    expect(current.endAt).toBe(next.startAt);
  });

  it('月粒度でも接する', () => {
    const current = resolveReportRange('2026-09-15', 'month', TOKYO, 1);
    const next = nextRange('2026-09-15', 'month');

    expect(current.endAt).toBe(next.startAt);
    expect(next.lengthMinutes).toBe(31 * 1440); // 10 月
  });
});

describe('clipMinutes', () => {
  const rangeStart = '2026-09-01T00:00:00.000Z';
  const rangeEnd = '2026-09-08T00:00:00.000Z';

  it('期間に完全に収まるブロックは全長を返す', () => {
    expect(
      clipMinutes('2026-09-02T09:00:00.000Z', '2026-09-02T10:30:00.000Z', rangeStart, rangeEnd),
    ).toBe(90);
  });

  it('先頭で跨ぐブロックは期間内の分だけ返す', () => {
    // 08-31 22:00 〜 09-01 06:00 のうち、期間内は 6 時間
    expect(
      clipMinutes('2026-08-31T22:00:00.000Z', '2026-09-01T06:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(360);
  });

  it('末尾で跨ぐブロックは期間内の分だけ返す', () => {
    // 09-07 23:00 〜 09-08 07:00 のうち、期間内は 1 時間
    expect(
      clipMinutes('2026-09-07T23:00:00.000Z', '2026-09-08T07:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(60);
  });

  it('期間外のブロックは 0', () => {
    expect(
      clipMinutes('2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(0);
  });

  it('期間の終端に接するだけのブロックは 0（半開区間）', () => {
    expect(
      clipMinutes('2026-09-08T00:00:00.000Z', '2026-09-08T01:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(0);
  });

  it('期間の開始に接するブロックは計上される（半開区間）', () => {
    expect(
      clipMinutes('2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(60);
  });

  it('長さ 0 のブロックは 0', () => {
    expect(
      clipMinutes('2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z', rangeStart, rangeEnd),
    ).toBe(0);
  });

  it('境界を跨ぐブロックが両側の期間へ分かれて計上され、合計が全長と一致する', () => {
    // 日曜 23:00 JST 開始、月曜 07:00 JST 終了の睡眠（8 時間）
    const sleepStart = '2026-09-06T14:00:00.000Z'; // JST 09-06(日) 23:00
    const sleepEnd = '2026-09-06T22:00:00.000Z'; // JST 09-07(月) 07:00

    const thisWeek = resolveReportRange('2026-09-02', 'week', TOKYO, 1); // 08-31 〜 09-07
    const nextWeek = resolveReportRange('2026-09-09', 'week', TOKYO, 1); // 09-07 〜 09-14

    const inThisWeek = clipMinutes(sleepStart, sleepEnd, thisWeek.startAt, thisWeek.endAt);
    const inNextWeek = clipMinutes(sleepStart, sleepEnd, nextWeek.startAt, nextWeek.endAt);

    expect(inThisWeek).toBe(60); // JST 23:00 〜 24:00
    expect(inNextWeek).toBe(420); // JST 00:00 〜 07:00
    expect(inThisWeek + inNextWeek).toBe(480); // 合計は元の 8 時間
  });
});

describe('distributeToBuckets', () => {
  const week = resolveReportRange('2026-09-02', 'week', TOKYO, 1); // 08-31(月) 〜 09-06(日)

  it('1 日に収まるブロックは 1 列だけに乗る', () => {
    // JST 09-02(水) 09:00 〜 10:30
    const byBucket = distributeToBuckets(
      '2026-09-02T00:00:00.000Z',
      '2026-09-02T01:30:00.000Z',
      week.buckets,
    );

    expect(byBucket).toEqual([0, 0, 90, 0, 0, 0, 0]);
  });

  it('0 時をまたぐブロックが 2 日へ按分され、合計が全長と一致する', () => {
    // JST 09-02(水) 23:00 〜 09-03(木) 07:00（8 時間）
    const start = '2026-09-02T14:00:00.000Z';
    const end = '2026-09-02T22:00:00.000Z';
    const byBucket = distributeToBuckets(start, end, week.buckets);

    expect(byBucket[2]).toBe(60); // 水曜ぶん 23:00〜24:00
    expect(byBucket[3]).toBe(420); // 木曜ぶん 00:00〜07:00
    expect(byBucket.reduce((sum, value) => sum + value, 0)).toBe(480);
    expect(byBucket.reduce((sum, value) => sum + value, 0)).toBe(
      clipMinutes(start, end, week.startAt, week.endAt),
    );
  });

  it('期間外のブロックはどの列にも乗らない', () => {
    const byBucket = distributeToBuckets(
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T01:00:00.000Z',
      week.buckets,
    );

    expect(byBucket.every((value) => value === 0)).toBe(true);
  });

  it('期間の先頭で跨ぐブロックは最初の列にだけ乗る', () => {
    // JST 08-30(日) 22:00 〜 08-31(月) 02:00
    const byBucket = distributeToBuckets(
      '2026-08-30T13:00:00.000Z',
      '2026-08-30T17:00:00.000Z',
      week.buckets,
    );

    expect(byBucket[0]).toBe(120); // 期間内は 08-31 00:00〜02:00 のみ
    expect(byBucket.slice(1).every((value) => value === 0)).toBe(true);
  });

  it('年粒度では月の列へ按分される', () => {
    const year = resolveReportRange('2026-06-15', 'year', TOKYO, 1);
    // JST 2026-01-31 23:00 〜 2026-02-01 05:00（6 時間）
    const byBucket = distributeToBuckets(
      '2026-01-31T14:00:00.000Z',
      '2026-01-31T20:00:00.000Z',
      year.buckets,
    );

    expect(byBucket[0]).toBe(60); // 1 月
    expect(byBucket[1]).toBe(300); // 2 月
  });
});

describe('isReportGranularity', () => {
  it('週 / 月 / 年だけを受け付ける', () => {
    expect(isReportGranularity('week')).toBe(true);
    expect(isReportGranularity('month')).toBe(true);
    expect(isReportGranularity('year')).toBe(true);
    expect(isReportGranularity('day')).toBe(false);
    expect(isReportGranularity(undefined)).toBe(false);
    expect(isReportGranularity(1)).toBe(false);
  });
});

describe('todayReportAnchor', () => {
  it('timezone ごとに日付が変わる', () => {
    // UTC 2026-09-02 16:00 は JST では 09-03
    const now = new Date('2026-09-02T16:00:00.000Z');

    expect(todayReportAnchor(UTC, now)).toBe('2026-09-02');
    expect(todayReportAnchor(TOKYO, now)).toBe('2026-09-03');
    expect(todayReportAnchor(NEW_YORK, now)).toBe('2026-09-02');
  });
});
