import { describe, expect, it } from 'vitest';

import {
  mergeTimeblockSearchResults,
  type TimeblockSearchSourceRow,
} from './timeblock-search-results';

function createRow(
  id: string,
  startAt: string,
  overrides: Partial<TimeblockSearchSourceRow> = {},
): TimeblockSearchSourceRow {
  return {
    id,
    note: null,
    activity_id: null,
    start_at: startAt,
    end_at: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('mergeTimeblockSearchResults', () => {
  it('PlanとRecordを開始日時の新しい順へ統合する', () => {
    const plans = [
      createRow('plan-old', '2026-07-13T09:00:00.000Z'),
      createRow('plan-new', '2026-07-15T09:00:00.000Z'),
    ];
    const records = [createRow('record-middle', '2026-07-14T09:00:00.000Z')];

    const merged = mergeTimeblockSearchResults(plans, records);

    expect(merged.results.map(({ id }) => id)).toEqual(['plan-new', 'record-middle', 'plan-old']);
    expect(merged.results[0]).not.toHaveProperty('title');
    expect(merged.hasMore).toBe(false);
  });

  it('同じ開始日時では入力順を維持する', () => {
    const startAt = '2026-07-15T09:00:00.000Z';
    const plans = [createRow('plan-a', startAt), createRow('plan-b', startAt)];
    const records = [createRow('record-a', startAt)];

    const merged = mergeTimeblockSearchResults(plans, records);

    expect(merged.results.map(({ id }) => id)).toEqual(['plan-a', 'plan-b', 'record-a']);
  });

  it('上限を適用し、残りがあることを返す', () => {
    const plans = Array.from({ length: 12 }, (_, index) =>
      createRow(`plan-${index}`, new Date(Date.UTC(2026, 6, 15, index)).toISOString()),
    );
    const records = Array.from({ length: 12 }, (_, index) =>
      createRow(`record-${index}`, new Date(Date.UTC(2026, 6, 14, index)).toISOString()),
    );

    const merged = mergeTimeblockSearchResults(plans, records, 20);

    expect(merged.results).toHaveLength(20);
    expect(merged.hasMore).toBe(true);
  });

  it('検索結果に手動の未実施状態を付けない', () => {
    const startAt = '2026-07-15T09:00:00.000Z';
    const plans = [createRow('plan', startAt)];
    const records = [createRow('record', startAt)];

    const merged = mergeTimeblockSearchResults(plans, records);

    expect(merged.results).toEqual([
      expect.objectContaining({ id: 'plan', kind: 'plan' }),
      expect.objectContaining({ id: 'record', kind: 'record' }),
    ]);
  });
});
