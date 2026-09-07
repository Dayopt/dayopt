import { toDerivedBlock } from '@/lib/database';
import { describe, expect, it } from 'vitest';

import {
  aggregatePlanRecordEstimationAccuracy,
  type EstimationAccuracyActivityLookup,
  type EstimationAccuracyDbRow,
  transformEstimationAccuracy,
} from './estimation-accuracy';

function makeRow(overrides: Partial<EstimationAccuracyDbRow> = {}): EstimationAccuracyDbRow {
  return {
    activity_id: 'activity-1',
    activity_name: 'Deep Work',
    activity_color: 'blue',
    is_uncategorized: false,
    avg_planned_minutes: 60,
    avg_actual_minutes: 75,
    avg_deviation_minutes: 15,
    record_count: 10,
    ...overrides,
  };
}

describe('transformEstimationAccuracy', () => {
  it('空配列 → 空配列', () => {
    expect(transformEstimationAccuracy([])).toEqual([]);
  });

  it('全フィールドを snake → camel に変換する', () => {
    const result = transformEstimationAccuracy([makeRow()]);
    expect(result[0]).toEqual({
      activityId: 'activity-1',
      activityName: 'Deep Work',
      activityColor: 'blue',
      isUncategorized: false,
      avgPlannedMinutes: 60,
      avgActualMinutes: 75,
      avgDeviationMinutes: 15,
      recordCount: 10,
    });
  });

  it('is_uncategorized な row は activityColor を null のまま返す（空文字フォールバックを適用しない）', () => {
    const result = transformEstimationAccuracy([
      makeRow({
        activity_id: null,
        activity_name: null,
        activity_color: null,
        is_uncategorized: true,
      }),
    ]);
    expect(result[0]).toEqual({
      activityId: null,
      activityName: null,
      activityColor: null,
      isUncategorized: true,
      avgPlannedMinutes: 60,
      avgActualMinutes: 75,
      avgDeviationMinutes: 15,
      recordCount: 10,
    });
  });

  it('activity_color が空文字 → indigo にフォールバック', () => {
    const result = transformEstimationAccuracy([makeRow({ activity_color: '' })]);
    expect(result[0]?.activityColor).toBe('indigo');
  });

  it('activity_color が値あり → そのまま保持', () => {
    const result = transformEstimationAccuracy([makeRow({ activity_color: 'crimson' })]);
    expect(result[0]?.activityColor).toBe('crimson');
  });

  it('複数 row → 各 row が独立に変換される', () => {
    const result = transformEstimationAccuracy([
      makeRow({ activity_id: 'a', activity_color: 'red' }),
      makeRow({ activity_id: 'b', activity_color: '' }),
      makeRow({ activity_id: 'c', activity_color: 'green' }),
    ]);
    expect(result.map((r) => r.activityId)).toEqual(['a', 'b', 'c']);
    expect(result.map((r) => r.activityColor)).toEqual(['red', 'indigo', 'green']);
  });

  it('0 / 負数の minutes / count を保持する', () => {
    const result = transformEstimationAccuracy([
      makeRow({
        avg_planned_minutes: 0,
        avg_actual_minutes: 0,
        avg_deviation_minutes: -30,
        record_count: 0,
      }),
    ]);
    expect(result[0]).toMatchObject({
      avgPlannedMinutes: 0,
      avgActualMinutes: 0,
      avgDeviationMinutes: -30,
      recordCount: 0,
    });
  });
});

it('compares independent activity totals even on different days', () => {
  const period = {
    startAt: '2026-09-01T00:00:00Z',
    endAt: '2026-10-01T00:00:00Z',
    timezone: 'UTC',
  };
  const plans = [1, 2].map((day) =>
    toDerivedBlock(
      {
        id: String(day),
        activity_id: 'a',
        start_at: `2026-09-0${day}T09:00:00Z`,
        end_at: `2026-09-0${day}T10:00:00Z`,
      },
      'plan',
    ),
  );
  const record = toDerivedBlock(
    { id: 'r', activity_id: 'a', start_at: '2026-09-04T09:00:00Z', end_at: '2026-09-04T12:00:00Z' },
    'rec',
  );
  const lookup = new Map<string, EstimationAccuracyActivityLookup>([
    ['a', { name: 'Activity', color: 'blue' }],
  ]);
  expect(
    aggregatePlanRecordEstimationAccuracy(
      [...plans, record],
      period,
      new Date(period.endAt),
      lookup,
    ),
  ).toMatchObject([
    {
      activity_id: 'a',
      avg_planned_minutes: 60,
      avg_actual_minutes: 90,
      avg_deviation_minutes: 30,
      record_count: 1,
    },
  ]);
});
