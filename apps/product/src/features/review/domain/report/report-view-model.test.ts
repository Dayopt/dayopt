import { describe, expect, it } from 'vitest';

import {
  answerCountOf,
  buildActivityUsageRows,
  buildAllocationSlices,
  buildCompassPoints,
  buildCompassWaitingList,
  buildDurationBins,
  buildExecutionRows,
  buildHourTotals,
  buildInkColumns,
  buildMirrorRows,
  buildUsageSummary,
  computeDenominators,
  countRecordBoxes,
  defaultReportFilterState,
  maxInkColumnMinutes,
  medianFromDurationCounts,
  mergeDurationCounts,
  normalizeReportPeriodPayload,
  resolveAllocationMode,
  resolveVisibleActivities,
  sortActivityUsageRows,
  toPercent,
  UNCATEGORIZED_KEY,
} from './report-view-model';

import type { ReportActivityAggregate } from '../../server/report-aggregation-service';

function activity(overrides: Partial<ReportActivityAggregate> = {}): ReportActivityAggregate {
  return {
    activityId: 'a1',
    activityName: '執筆',
    categoryId: 'c1',
    categoryName: '仕事',
    categoryColor: 'blue',
    categoryIcon: 'pen',
    archived: false,
    recordedMinutes: 0,
    plannedMinutes: 0,
    plannedPastMinutes: 0,
    plannedPastBoxes: 0,
    recordBoxes: 0,
    durationCounts: [],
    byHour: Array.from({ length: 24 }, () => 0),
    fulfillment: { low: 0, medium: 0, high: 0 },
    byBucket: [0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

describe('resolveVisibleActivities', () => {
  const rows = [
    activity({ activityId: 'a1', categoryId: 'c1' }),
    activity({ activityId: 'a2', categoryId: 'c2' }),
    activity({ activityId: 'a3', categoryId: null, categoryName: null }),
  ];

  it('既定では全部見える', () => {
    expect(resolveVisibleActivities(rows, defaultReportFilterState)).toHaveLength(3);
  });

  it('hidden に載ったカテゴリだけ落とす', () => {
    const visible = resolveVisibleActivities(rows, {
      ...defaultReportFilterState,
      hiddenCategoryIds: ['c1'],
    });

    expect(visible.map((row) => row.activityId)).toEqual(['a2', 'a3']);
  });

  it('新しいカテゴリは hidden に載っていないので自動で見える', () => {
    const withNew = [...rows, activity({ activityId: 'a4', categoryId: 'c-new' })];

    const visible = resolveVisibleActivities(withNew, {
      ...defaultReportFilterState,
      hiddenCategoryIds: ['c1'],
    });

    expect(visible.map((row) => row.activityId)).toContain('a4');
  });

  it('hidden に載ったアクティビティだけ落とし、同じカテゴリーの他の行は残す', () => {
    const withSibling = [...rows, activity({ activityId: 'a1b', categoryId: 'c1' })];

    const visible = resolveVisibleActivities(withSibling, {
      ...defaultReportFilterState,
      hiddenActivityIds: ['a1'],
    });

    expect(visible.map((row) => row.activityId)).toEqual(['a2', 'a3', 'a1b']);
  });

  it('カテゴリーが隠れていればアクティビティを個別に隠していなくても落ちる', () => {
    const visible = resolveVisibleActivities(rows, {
      ...defaultReportFilterState,
      hiddenCategoryIds: ['c1'],
      hiddenActivityIds: ['a2'],
    });

    expect(visible.map((row) => row.activityId)).toEqual(['a3']);
  });

  it('未分類のアクティビティも個別に隠せる（アクティビティ未設定の行は残る）', () => {
    const withUnassigned = [...rows, activity({ activityId: null, categoryId: null })];

    const visible = resolveVisibleActivities(withUnassigned, {
      ...defaultReportFilterState,
      hiddenActivityIds: ['a3'],
    });

    expect(visible.map((row) => row.activityId)).toEqual(['a1', 'a2', null]);
  });

  it('アクティビティ未設定の行はどの hidden でも落ちない', () => {
    const withUnassigned = [...rows, activity({ activityId: null, categoryId: null })];

    const visible = resolveVisibleActivities(withUnassigned, {
      ...defaultReportFilterState,
      hiddenCategoryIds: ['c1', 'c2'],
      hiddenActivityIds: ['a3'],
    });

    expect(visible.map((row) => row.activityId)).toEqual([null]);
  });
});

describe('computeDenominators', () => {
  const all = [
    activity({ activityId: 'a1', categoryId: 'c1', recordedMinutes: 600 }),
    activity({ activityId: 'a2', categoryId: 'c2', recordedMinutes: 2400 }), // 睡眠相当
  ];

  it('track は記録の合計そのもの（余白は混ぜず、見出しの数字にだけ残す）', () => {
    const result = computeDenominators({
      allActivities: all,
      visibleActivities: all,
      lengthMinutes: 10080,
    });

    expect(result.totalAllMinutes).toBe(3000);
    expect(result.marginMinutes).toBe(7080);
    expect(result.visibleMinutes).toBe(3000);
    expect(result.trackMinutes).toBe(3000);
  });

  it('カテゴリを隠すと V と track から抜けるが、余白の値は変わらない', () => {
    const visible = all.filter((row) => row.activityId !== 'a2');

    const result = computeDenominators({
      allActivities: all,
      visibleActivities: visible,
      lengthMinutes: 10080,
    });

    expect(result.visibleMinutes).toBe(600);
    expect(result.trackMinutes).toBe(600);
    // 余白はフィルタに依存しない（仕様 §13-2）
    expect(result.marginMinutes).toBe(7080);
    expect(result.totalAllMinutes).toBe(3000);
  });

  it('データが無くても track は 1 以上（0 除算防止）', () => {
    const result = computeDenominators({
      allActivities: [],
      visibleActivities: [],
      lengthMinutes: 0,
    });

    expect(result.trackMinutes).toBe(1);
    expect(result.visibleMinutes).toBe(0);
  });

  it('記録が期間の長さを超えても余白は負のまま返す', () => {
    // 重なりのある記録などで totalAll が L を超えうる
    const over = [activity({ recordedMinutes: 20000 })];

    const result = computeDenominators({
      allActivities: over,
      visibleActivities: over,
      lengthMinutes: 10080,
    });

    expect(result.marginMinutes).toBe(-9920);
    expect(result.trackMinutes).toBe(20000);
  });
});

describe('toPercent', () => {
  it('track で割って丸める', () => {
    expect(toPercent(3000, 10080)).toBe(30);
    expect(toPercent(0, 10080)).toBe(0);
  });

  it('track が 0 でも壊れない', () => {
    expect(toPercent(10, 0)).toBe(1000);
  });
});

describe('buildAllocationSlices', () => {
  const rows = [
    activity({ activityId: 'a1', categoryId: 'c1', categoryName: '仕事', recordedMinutes: 600 }),
    activity({ activityId: 'a2', categoryId: 'c1', categoryName: '仕事', recordedMinutes: 300 }),
    activity({
      activityId: 'a3',
      categoryId: null,
      categoryName: null,
      categoryColor: null,
      recordedMinutes: 120,
    }),
    activity({ activityId: 'a4', categoryId: 'c2', categoryName: '生活', recordedMinutes: 0 }),
  ];

  it('カテゴリー別にまとめ、記録の多い順に並べる', () => {
    const slices = buildAllocationSlices(rows, 1020, 'category');

    expect(slices.map((slice) => slice.key)).toEqual(['c1', UNCATEGORIZED_KEY]);
    expect(slices[0]?.minutes).toBe(900);
    expect(slices[0]?.label).toBe('仕事');
    expect(slices[1]?.minutes).toBe(120);
  });

  it('記録 0 のカテゴリは行を持たない', () => {
    expect(buildAllocationSlices(rows, 1020, 'category').some((s) => s.key === 'c2')).toBe(false);
  });

  it('区画の合計が記録の合計（100%）になり、余白の区画は作らない', () => {
    const slices = buildAllocationSlices(rows, 1020, 'category');
    const total = slices.reduce((sum, slice) => sum + slice.minutes, 0);

    expect(total).toBe(1020);
    expect(slices.reduce((sum, slice) => sum + slice.percent, 0)).toBe(100);
    expect(slices.some((slice) => slice.key === '__margin')).toBe(false);
  });

  it('アクティビティ別に割ると名前がアクティビティになる', () => {
    const slices = buildAllocationSlices(rows, 1020, 'activity');

    expect(slices.map((slice) => slice.key)).toEqual(['a1', 'a2', 'a3']);
    expect(slices[0]?.label).toBe('執筆');
  });

  it('インクが無ければ空', () => {
    expect(buildAllocationSlices([], 1, 'category')).toEqual([]);
  });
});

describe('resolveAllocationMode', () => {
  it('記録のあるカテゴリーが 2 つ以上ならカテゴリー別', () => {
    expect(
      resolveAllocationMode([
        activity({ activityId: 'a1', categoryId: 'c1', recordedMinutes: 10 }),
        activity({ activityId: 'a2', categoryId: null, recordedMinutes: 10 }),
      ]),
    ).toBe('category');
  });

  it('カテゴリーが 1 つでアクティビティが 2 つ以上ならアクティビティ別', () => {
    expect(
      resolveAllocationMode([
        activity({ activityId: 'a1', categoryId: 'c1', recordedMinutes: 10 }),
        activity({ activityId: 'a2', categoryId: 'c1', recordedMinutes: 10 }),
        // 記録 0 の別カテゴリーは数えない（見えていても区画にならない）
        activity({ activityId: 'a3', categoryId: 'c2', recordedMinutes: 0 }),
      ]),
    ).toBe('activity');
  });

  it('アクティビティが 1 つだけなら配分を出さない', () => {
    expect(
      resolveAllocationMode([
        activity({ activityId: 'a1', categoryId: 'c1', recordedMinutes: 10 }),
      ]),
    ).toBe('none');
    expect(resolveAllocationMode([])).toBe('none');
  });
});

describe('countRecordBoxes', () => {
  it('見えている行の件数を足す', () => {
    expect(
      countRecordBoxes([
        activity({ recordBoxes: 3 }),
        activity({ activityId: 'a2', recordBoxes: 4 }),
      ]),
    ).toBe(7);
  });
});

describe('buildActivityUsageRows / sortActivityUsageRows', () => {
  const rows = [
    activity({
      activityId: 'a1',
      activityName: '執筆',
      recordedMinutes: 600,
      recordBoxes: 5,
      durationCounts: [
        [60, 2],
        [90, 1],
        [120, 2],
      ],
    }),
    activity({
      activityId: 'a2',
      activityName: '会議',
      recordedMinutes: 300,
      recordBoxes: 6,
      durationCounts: [],
    }),
    activity({ activityId: 'a3', activityName: '散歩', recordedMinutes: 0 }),
    activity({ activityId: 'a4', activityName: '新規', recordedMinutes: 120, recordBoxes: 2 }),
  ];
  const previous = [
    { activityId: 'a1', recordedMinutes: 400 },
    { activityId: 'a2', recordedMinutes: 500 },
  ];

  it('記録のある行だけを、中央値と前期間との差付きで返す', () => {
    const result = buildActivityUsageRows(rows, previous);

    expect(result.map((row) => row.activityId)).toEqual(['a1', 'a2', 'a4']);
    expect(result[0]).toMatchObject({ recordBoxes: 5, medianRecordMinutes: 90, deltaMinutes: 200 });
    // 行の中央値はサーバーのスカラーではなく度数から出す（60, 60, 90, 120, 120 → 90）
    expect(result[1]).toMatchObject({ medianRecordMinutes: null, deltaMinutes: -200 });
    // 前期間に無かった行は増分がそのまま差になる
    expect(result[2]?.deltaMinutes).toBe(120);
  });

  it('前期間にインクが無ければ差を作らない（見出しの Δ と同じ規則）', () => {
    const result = buildActivityUsageRows(rows, []);

    expect(result.every((row) => row.deltaMinutes === null)).toBe(true);
  });

  it('既定は記録時間の多い順、差の順では増えたものが先頭で null は末尾', () => {
    const result = buildActivityUsageRows(rows, previous);

    expect(sortActivityUsageRows(result, 'recorded').map((row) => row.activityId)).toEqual([
      'a1',
      'a2',
      'a4',
    ]);
    expect(sortActivityUsageRows(result, 'delta').map((row) => row.activityId)).toEqual([
      'a1',
      'a4',
      'a2',
    ]);

    const withoutPrevious = buildActivityUsageRows(rows, []);
    expect(sortActivityUsageRows(withoutPrevious, 'delta').map((row) => row.activityId)).toEqual([
      'a1',
      'a2',
      'a4',
    ]);
  });
});

describe('medianFromDurationCounts / mergeDurationCounts', () => {
  it('度数から中央値を出す（奇数件は真ん中、偶数件は中央 2 件の平均）', () => {
    expect(
      medianFromDurationCounts([
        [30, 1],
        [60, 1],
        [120, 1],
      ]),
    ).toBe(60);
    expect(
      medianFromDurationCounts([
        [30, 2],
        [60, 2],
      ]),
    ).toBe(45);
    expect(
      medianFromDurationCounts([
        [15, 5],
        [90, 1],
      ]),
    ).toBe(15);
    expect(medianFromDurationCounts([])).toBeNull();
  });

  /** 中央値の中央値は中央値にならない。全体は度数を合算してから出す。 */
  it('複数のアクティビティの度数を合算してから中央値を出す', () => {
    const merged = mergeDurationCounts([
      [[10, 3]],
      [
        [10, 1],
        [120, 3],
      ],
    ]);

    expect(merged).toEqual([
      [10, 4],
      [120, 3],
    ]);
    // 各中央値（10 と 120）の中央値 65 ではなく、7 件の真ん中 = 10
    expect(medianFromDurationCounts(merged)).toBe(10);
  });
});

describe('buildUsageSummary', () => {
  const visible = [
    activity({
      activityId: 'a1',
      recordedMinutes: 600,
      recordBoxes: 4,
      durationCounts: [[150, 4]],
    }),
    activity({ activityId: 'a2', recordedMinutes: 60, recordBoxes: 2, durationCounts: [[30, 2]] }),
  ];

  it('見えている集合の記録時間・件数・中央値を返す', () => {
    expect(buildUsageSummary(visible, []).current).toEqual({
      recordedMinutes: 660,
      recordCount: 6,
      medianMinutes: 150,
    });
  });

  it('前期間は今見えているアクティビティだけで足す', () => {
    const summary = buildUsageSummary(visible, [
      { activityId: 'a1', recordedMinutes: 300, recordBoxes: 3, durationCounts: [[100, 3]] },
      // 今は隠している（見えていない）アクティビティの前期間は比べない
      { activityId: 'a9', recordedMinutes: 900, recordBoxes: 9, durationCounts: [[100, 9]] },
    ]);

    expect(summary.previous).toEqual({ recordedMinutes: 300, recordCount: 3, medianMinutes: 100 });
  });

  it('前期間にインクが無ければ比較しない', () => {
    expect(buildUsageSummary(visible, []).previous).toBeNull();
  });
});

describe('buildHourTotals', () => {
  it('見えているアクティビティの時間帯を足す', () => {
    const hours = (entries: Record<number, number>) =>
      Array.from({ length: 24 }, (_, hour) => entries[hour] ?? 0);

    const totals = buildHourTotals([
      activity({ activityId: 'a1', byHour: hours({ 9: 30, 10: 60 }) }),
      activity({ activityId: 'a2', byHour: hours({ 10: 15 }) }),
    ]);

    expect(totals[9]).toBe(30);
    expect(totals[10]).toBe(75);
    expect(totals).toHaveLength(24);
  });
});

describe('buildDurationBins', () => {
  it('下限を含み上限を含まないビンへ振り分ける', () => {
    const bins = buildDurationBins([
      [4, 1],
      [5, 2],
      [29, 1],
      [30, 1],
      [240, 3],
    ]);

    const countFrom = (from: number) => bins.find((bin) => bin.fromMinutes === from)?.count;
    expect(countFrom(0)).toBe(1);
    expect(countFrom(5)).toBe(2);
    expect(countFrom(15)).toBe(1);
    expect(countFrom(30)).toBe(1);
    expect(countFrom(120)).toBe(3);
    expect(bins.at(-1)?.toMinutes).toBeNull();
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(8);
  });
});

describe('buildInkColumns', () => {
  const keys = ['2026-08-31', '2026-09-01', '2026-09-02'];
  const rows = [
    activity({
      activityId: 'a1',
      categoryId: 'c1',
      categoryName: '仕事',
      byBucket: [60, 120, 0],
    }),
    activity({
      activityId: 'a2',
      categoryId: 'c2',
      categoryName: '生活',
      byBucket: [30, 0, 0],
    }),
  ];

  it('列ごとにカテゴリーを積み上げる', () => {
    const columns = buildInkColumns(rows, keys);

    expect(columns).toHaveLength(3);
    expect(columns[0]?.totalMinutes).toBe(90);
    expect(columns[0]?.stacks.map((stack) => stack.key)).toEqual(['c1', 'c2']);
    expect(columns[1]?.totalMinutes).toBe(120);
    expect(columns[2]?.stacks).toEqual([]);
  });

  it('未分類は擬似カテゴリのキーになる', () => {
    const columns = buildInkColumns(
      [activity({ categoryId: null, categoryName: null, byBucket: [45, 0, 0] })],
      keys,
    );

    expect(columns[0]?.stacks[0]?.key).toBe(UNCATEGORIZED_KEY);
  });

  it('全列 0 でもスケールが 1 以上', () => {
    expect(maxInkColumnMinutes(buildInkColumns([], keys))).toBe(1);
  });

  it('最大列の分数を返す', () => {
    expect(maxInkColumnMinutes(buildInkColumns(rows, keys))).toBe(120);
  });
});

describe('buildExecutionRows', () => {
  it('記録か予定があれば行になり、rec 降順で並ぶ', () => {
    const rows = buildExecutionRows([
      activity({ activityId: 'a1', recordedMinutes: 100 }),
      activity({ activityId: 'a2', recordedMinutes: 300 }),
      activity({ activityId: 'a3', recordedMinutes: 0, plannedMinutes: 60 }),
      activity({ activityId: 'a4', recordedMinutes: 0, plannedMinutes: 0 }),
    ]);

    expect(rows.map((row) => row.activityId)).toEqual(['a2', 'a1', 'a3']);
  });

  it('件数上限で切らない（決算の完全性）', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      activity({ activityId: `a${index}`, recordedMinutes: index + 1 }),
    );

    expect(buildExecutionRows(many)).toHaveLength(40);
  });

  it('バー幅を行の最大値で正規化する', () => {
    const rows = buildExecutionRows([
      activity({ activityId: 'a1', recordedMinutes: 300, plannedMinutes: 600 }),
      activity({ activityId: 'a2', recordedMinutes: 150 }),
    ]);

    // 最大は a1 の予定 600
    expect(rows[0]?.recordedRatio).toBeCloseTo(0.5);
    expect(rows[0]?.plannedRatio).toBeCloseTo(1);
    expect(rows[1]?.recordedRatio).toBeCloseTo(0.25);
  });

  it('予定が無い行は予定バーを描かない', () => {
    const rows = buildExecutionRows([activity({ recordedMinutes: 100 })]);

    expect(rows[0]?.plannedRatio).toBeNull();
  });

  it('過去予定が 15 分未満なら予定比を作らない', () => {
    const rows = buildExecutionRows([
      activity({
        activityId: 'a1',
        recordedMinutes: 100,
        plannedMinutes: 600,
        plannedPastMinutes: 14,
      }),
    ]);

    expect(rows[0]?.planRatioPercent).toBeNull();
  });

  it('過去予定がちょうど 15 分なら予定比を出す', () => {
    const rows = buildExecutionRows([
      activity({ activityId: 'a1', recordedMinutes: 30, plannedPastMinutes: 15 }),
    ]);

    expect(rows[0]?.planRatioPercent).toBe(200);
  });

  it('未来の予定は予定比に影響しない', () => {
    const rows = buildExecutionRows([
      activity({
        activityId: 'a1',
        recordedMinutes: 60,
        plannedMinutes: 600, // 未来の予定を含む合計
        plannedPastMinutes: 60,
      }),
    ]);

    expect(rows[0]?.planRatioPercent).toBe(100);
  });

  it('行が無ければ空', () => {
    expect(buildExecutionRows([])).toEqual([]);
  });
});

describe('buildMirrorRows', () => {
  const candidate = (overrides: Partial<ReportActivityAggregate>) =>
    activity({
      recordedMinutes: 120,
      plannedPastMinutes: 60,
      plannedPastBoxes: 3,
      ...overrides,
    });

  it('候補条件を満たす行だけを返す', () => {
    const rows = buildMirrorRows([
      candidate({ activityId: 'ok' }),
      candidate({ activityId: 'few-boxes', plannedPastBoxes: 2 }),
      candidate({ activityId: 'short-plan', plannedPastMinutes: 29 }),
      candidate({ activityId: 'no-record', recordedMinutes: 0 }),
    ]);

    expect(rows.map((row) => row.activityId)).toEqual(['ok']);
  });

  it('箱数がちょうど 3、過去予定がちょうど 30 分なら候補になる', () => {
    const rows = buildMirrorRows([
      candidate({ activityId: 'edge', plannedPastBoxes: 3, plannedPastMinutes: 30 }),
    ]);

    expect(rows).toHaveLength(1);
  });

  it('癖の強い順（|coef − 1| 降順）に並べ、最大 3 件', () => {
    const rows = buildMirrorRows([
      candidate({ activityId: 'a', recordedMinutes: 66, plannedPastMinutes: 60 }), // 1.10
      candidate({ activityId: 'b', recordedMinutes: 120, plannedPastMinutes: 60 }), // 2.00
      candidate({ activityId: 'c', recordedMinutes: 30, plannedPastMinutes: 60 }), // 0.50
      candidate({ activityId: 'd', recordedMinutes: 90, plannedPastMinutes: 60 }), // 1.50
    ]);

    expect(rows.map((row) => row.activityId)).toEqual(['b', 'c', 'd']);
    expect(rows).toHaveLength(3);
  });

  it('係数から文言のトーンを決める', () => {
    const rows = buildMirrorRows([
      candidate({ activityId: 'over', recordedMinutes: 68, plannedPastMinutes: 60 }), // 1.133
      candidate({ activityId: 'under', recordedMinutes: 51, plannedPastMinutes: 60 }), // 0.85
      candidate({ activityId: 'on-plan', recordedMinutes: 60, plannedPastMinutes: 60 }), // 1.00
    ]);

    const toneOf = (id: string) => rows.find((row) => row.activityId === id)?.tone;
    expect(toneOf('over')).toBe('over');
    expect(toneOf('under')).toBe('under');
    expect(toneOf('on-plan')).toBe('onPlan');
  });

  it('候補が無ければ空（合成値を作らない）', () => {
    expect(buildMirrorRows([activity({ recordedMinutes: 100 })])).toEqual([]);
  });
});

describe('buildCompassPoints', () => {
  const answered = (overrides: Partial<ReportActivityAggregate>) =>
    activity({
      recordedMinutes: 300,
      fulfillment: { low: 0, medium: 0, high: 5 },
      ...overrides,
    });

  it('回答が 5 件以上の行だけが点になる', () => {
    const points = buildCompassPoints([
      answered({ activityId: 'ok' }),
      answered({ activityId: 'few', fulfillment: { low: 1, medium: 1, high: 2 } }),
      answered({ activityId: 'no-record', recordedMinutes: 0 }),
    ]);

    expect(points.map((point) => point.activityId)).toEqual(['ok']);
  });

  it('x は投下時間に比例し、最大の行が右端に来る', () => {
    const points = buildCompassPoints([
      answered({ activityId: 'big', recordedMinutes: 600 }),
      answered({ activityId: 'small', recordedMinutes: 300 }),
    ]);

    const big = points.find((point) => point.activityId === 'big');
    const small = points.find((point) => point.activityId === 'small');
    expect(big?.x).toBeCloseTo(92); // 6 + 1 * 86
    expect(small?.x).toBeCloseTo(49); // 6 + 0.5 * 86
  });

  it('y は充実と消耗の差で決まる', () => {
    const points = buildCompassPoints([
      answered({ activityId: 'all-high', fulfillment: { low: 0, medium: 0, high: 5 } }),
      answered({ activityId: 'all-low', fulfillment: { low: 5, medium: 0, high: 0 } }),
      answered({ activityId: 'neutral', fulfillment: { low: 0, medium: 5, high: 0 } }),
    ]);

    const yOf = (id: string) => points.find((point) => point.activityId === id)?.y;
    expect(yOf('all-high')).toBeCloseTo(86); // slope 1
    expect(yOf('all-low')).toBeCloseTo(14); // slope -1
    expect(yOf('neutral')).toBeCloseTo(50); // slope 0
  });

  /** 読み上げラベルが投下時間を語るので、点は記録時間を持ったまま出す。 */
  it('点が投下時間を持ち帰る', () => {
    const points = buildCompassPoints([answered({ activityId: 'ok', recordedMinutes: 420 })]);

    expect(points[0]?.recordedMinutes).toBe(420);
  });

  it('濃度が回答数に比例し、5 件で頭打ちになる', () => {
    const points = buildCompassPoints([
      answered({ activityId: 'five', fulfillment: { low: 0, medium: 0, high: 5 } }),
      answered({ activityId: 'ten', fulfillment: { low: 0, medium: 0, high: 10 } }),
      answered({ activityId: 'six', fulfillment: { low: 1, medium: 0, high: 5 } }),
    ]);

    const opacityOf = (id: string) => points.find((point) => point.activityId === id)?.opacity;
    expect(opacityOf('five')).toBeCloseTo(1);
    expect(opacityOf('ten')).toBeCloseTo(1);
    expect(opacityOf('six')).toBeCloseTo(1);
  });

  it('回答が 1 件も無ければ点が生まれず、エラーにもならない', () => {
    expect(buildCompassPoints([activity({ recordedMinutes: 600 })])).toEqual([]);
    expect(buildCompassPoints([])).toEqual([]);
  });
});

describe('buildCompassWaitingList', () => {
  it('記録があって回答が 5 件未満の行を、記録の多い順に並べる', () => {
    const waiting = buildCompassWaitingList([
      activity({ activityId: 'a1', activityName: 'A', recordedMinutes: 100 }),
      activity({ activityId: 'a2', activityName: 'B', recordedMinutes: 300 }),
      activity({
        activityId: 'a3',
        activityName: 'C',
        recordedMinutes: 200,
        fulfillment: { low: 0, medium: 0, high: 5 },
      }),
      activity({ activityId: 'a4', activityName: 'D', recordedMinutes: 0 }),
    ]);

    expect(waiting.map((row) => row.name)).toEqual(['B', 'A']);
  });

  it('回答がちょうど 4 件なら待機、5 件なら卒業', () => {
    const rows = [
      activity({
        activityId: 'four',
        recordedMinutes: 100,
        fulfillment: { low: 1, medium: 2, high: 1 },
      }),
      activity({
        activityId: 'five',
        recordedMinutes: 100,
        fulfillment: { low: 1, medium: 2, high: 2 },
      }),
    ];

    expect(buildCompassWaitingList(rows).map((row) => row.activityId)).toEqual(['four']);
    expect(buildCompassPoints(rows).map((point) => point.activityId)).toEqual(['five']);
  });
});

describe('answerCountOf', () => {
  it('3 値の和を返す', () => {
    expect(answerCountOf(activity({ fulfillment: { low: 1, medium: 2, high: 3 } }))).toBe(6);
    expect(answerCountOf(activity())).toBe(0);
  });
});

describe('normalizeReportPeriodPayload', () => {
  /** 永続化 cache に残った、項目を足す前の形。描画の合算で落ちないよう空で補う。 */
  it('足りない項目を空で補い、ある項目はそのまま残す', () => {
    const {
      durationCounts: _durationCounts,
      byHour: _byHour,
      ...legacy
    } = activity({
      activityId: 'a1',
      recordedMinutes: 60,
    });
    const current = activity({ activityId: 'a2', durationCounts: [[30, 1]] });

    const normalized = normalizeReportPeriodPayload({
      nowAt: '2026-09-04T00:00:00.000Z',
      activities: [legacy, current],
      previousActivities: [{ activityId: 'a1', recordedMinutes: 10 }],
    });

    expect(normalized.nowAt).toBe('2026-09-04T00:00:00.000Z');
    expect(normalized.activities[0]).toMatchObject({
      activityId: 'a1',
      recordedMinutes: 60,
      durationCounts: [],
      byHour: [],
    });
    expect(normalized.activities[1]?.durationCounts).toEqual([[30, 1]]);
    expect(normalized.previousActivities[0]).toEqual({
      activityId: 'a1',
      recordedMinutes: 10,
      recordBoxes: 0,
      durationCounts: [],
    });
  });
});
