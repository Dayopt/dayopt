import { describe, expect, it } from 'vitest';

import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';
import { StatisticsService } from './statistics-service';
import type { ServiceSupabaseClient } from './types';

const USER_ID = 'user-stats-1';

/** 中央値の窓（直近 28 日）を固定するための基準時刻。fixture の日付はこの窓の中にある */
const NOW = new Date('2026-07-15T00:00:00Z');

function record(id: string, activityId: string, startAt: string, endAt: string, source = 'manual') {
  return { id, activity_id: activityId, source, start_at: startAt, end_at: endAt };
}

function createService(tableData: Record<string, ReturnType<typeof createChainableMock>>) {
  const mockSupabase = createMockSupabase();
  mockSupabase.from.mockImplementation((table: string) => {
    const mock = tableData[table];
    if (!mock) throw new Error(`Unexpected table access in test: ${table}`);
    return mock;
  });
  return {
    mockSupabase,
    service: new StatisticsService(mockSupabase as unknown as ServiceSupabaseClient),
  };
}

describe('StatisticsService.getActivityStats', () => {
  it('records をアクティビティ別に集計し counts/lastUsed を返す（deleted は除外済み前提）', async () => {
    const { service } = createService({
      records: createChainableMock([
        {
          id: 'l1',
          activity_id: 'activity-1',

          source: 'manual',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
        {
          id: 'l2',
          activity_id: 'activity-1',

          source: 'manual',
          start_at: '2026-07-02T00:00:00Z',
          end_at: '2026-07-02T01:00:00Z',
        },
        {
          id: 'l3',
          activity_id: 'activity-2',

          source: 'manual',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
      ]),
      plans: createChainableMock([]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);

    // counts は records のみの実績件数（サイドバー等の「実績件数」表示用途の契約は不変）
    expect(result.counts).toEqual({ 'activity-1': 2, 'activity-2': 1 });
    expect(result.lastUsed).toEqual({
      'activity-1': '2026-07-02T00:00:00Z',
      'activity-2': '2026-07-01T00:00:00Z',
    });
    expect(result.planCounts).toEqual({});
    // どのアクティビティも記録 3 件未満なので中央値は出さない（沈黙）
    expect(result.medianMinutes).toEqual({});
  });

  it('record が無い場合は空の counts/lastUsed/planCounts を返す', async () => {
    const { service } = createService({
      records: createChainableMock([]),
      plans: createChainableMock([]),
    });
    expect(await service.getActivityStats(USER_ID, NOW)).toEqual({
      counts: {},
      lastUsed: {},
      planCounts: {},
      medianMinutes: {},
    });
  });

  it('Plan のみ（record 無し）のアクティビティは counts=0 のまま、planCounts に件数が反映される（#1576フォローアップ）', async () => {
    const { service } = createService({
      records: createChainableMock([]),
      plans: createChainableMock([
        {
          id: 'p1',
          activity_id: 'activity-future',
          start_at: '2026-08-10T00:00:00Z',
          end_at: '2026-08-10T01:00:00Z',
        },
      ]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);

    // records が無いアクティビティは counts に現れない（0 扱い） — 削除確認の合計判定は呼び出し側が
    // counts + planCounts を合算する（apps/product/src/features/calendar/components/
    // activity-filter/activity-delete-counts.ts の mergeActivityDeleteCounts）
    expect(result.counts['activity-future']).toBeUndefined();
    expect(result.planCounts).toEqual({ 'activity-future': 1 });
  });

  it('records と plans 両方を持つアクティビティは counts/planCounts がそれぞれ独立して反映される', async () => {
    const { service } = createService({
      records: createChainableMock([
        {
          id: 'l1',
          activity_id: 'activity-1',

          source: 'from_plan',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
      ]),
      plans: createChainableMock([
        {
          id: 'p1',
          activity_id: 'activity-1',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
        {
          id: 'p2',
          activity_id: 'activity-1',
          start_at: '2026-07-08T00:00:00Z',
          end_at: '2026-07-08T01:00:00Z',
        },
      ]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);

    expect(result.counts).toEqual({ 'activity-1': 1 });
    expect(result.planCounts).toEqual({ 'activity-1': 2 });
  });

  it('activity_id が null の Plan（未分類）は planCounts に含めない', async () => {
    const { service } = createService({
      records: createChainableMock([]),
      plans: createChainableMock([
        {
          id: 'p1',
          activity_id: null,
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
      ]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);
    expect(result.planCounts).toEqual({});
  });

  it('記録が 3 件以上のアクティビティは 5 分丸めの中央値を返し、3 件未満は返さない', async () => {
    const { service } = createService({
      records: createChainableMock([
        // activity-1: 30 / 44 / 60 分 → 中央値 44 → 5 分丸めで 45
        record('r1', 'activity-1', '2026-07-10T09:00:00Z', '2026-07-10T09:30:00Z'),
        record('r2', 'activity-1', '2026-07-11T09:00:00Z', '2026-07-11T09:44:00Z'),
        record('r3', 'activity-1', '2026-07-12T09:00:00Z', '2026-07-12T10:00:00Z'),
        // activity-2: 2 件だけ → 沈黙
        record('r4', 'activity-2', '2026-07-10T13:00:00Z', '2026-07-10T14:00:00Z'),
        record('r5', 'activity-2', '2026-07-11T13:00:00Z', '2026-07-11T14:00:00Z'),
      ]),
      plans: createChainableMock([]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);

    expect(result.medianMinutes).toEqual({ 'activity-1': 45 });
  });

  it('窓（直近 28 日）より前の記録は中央値に数えない', async () => {
    const { service } = createService({
      records: createChainableMock([
        // 3 件のうち 2 件は 28 日より前。窓内は 1 件だけになり n < 3 で沈黙する
        record('r1', 'activity-1', '2026-05-01T09:00:00Z', '2026-05-01T10:00:00Z'),
        record('r2', 'activity-1', '2026-05-02T09:00:00Z', '2026-05-02T10:00:00Z'),
        record('r3', 'activity-1', '2026-07-12T09:00:00Z', '2026-07-12T10:00:00Z'),
      ]),
      plans: createChainableMock([]),
    });

    const result = await service.getActivityStats(USER_ID, NOW);

    // 件数（counts）は全履歴のまま。窓を掛けるのは中央値だけ
    expect(result.counts).toEqual({ 'activity-1': 3 });
    expect(result.medianMinutes).toEqual({});
  });

  it('auto_migrated の記録は中央値に数えない（ユーザーが確定した実績ではない）', async () => {
    const { service } = createService({
      records: createChainableMock([
        record('r1', 'activity-1', '2026-07-10T09:00:00Z', '2026-07-10T10:00:00Z', 'auto_migrated'),
        record('r2', 'activity-1', '2026-07-11T09:00:00Z', '2026-07-11T10:00:00Z', 'auto_migrated'),
        record('r3', 'activity-1', '2026-07-12T09:00:00Z', '2026-07-12T10:00:00Z'),
      ]),
      plans: createChainableMock([]),
    });

    expect((await service.getActivityStats(USER_ID, NOW)).medianMinutes).toEqual({});
  });

  it('窓の境界に跨る記録は切り詰めず、実際の長さで数える', async () => {
    const { service } = createService({
      records: createChainableMock([
        // 窓の開始（NOW - 28 日 = 2026-06-17T00:00Z）を跨ぐ 2 時間の記録。
        // 切り詰めると 60 分になるが、「そのアクティビティの普段の長さ」は 120 分
        record('r1', 'activity-1', '2026-06-16T23:00:00Z', '2026-06-17T01:00:00Z'),
        record('r2', 'activity-1', '2026-07-11T09:00:00Z', '2026-07-11T11:00:00Z'),
        record('r3', 'activity-1', '2026-07-12T09:00:00Z', '2026-07-12T11:00:00Z'),
      ]),
      plans: createChainableMock([]),
    });

    expect((await service.getActivityStats(USER_ID, NOW)).medianMinutes).toEqual({
      'activity-1': 120,
    });
  });
});

describe('StatisticsService.getEstimationAccuracy', () => {
  it('plan に紐づく非 auto_migrated record を実績として 1:N 集計する', async () => {
    const { service, mockSupabase } = createService({
      plans: createChainableMock([
        {
          id: 'p1',
          activity_id: 'activity-1',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
        {
          id: 'p2',
          activity_id: 'activity-1',
          start_at: '2026-07-02T00:00:00Z',
          end_at: '2026-07-02T00:30:00Z',
        },
      ]),
      activities: createChainableMock([
        { id: 'activity-1', name: 'Deep Work', category_id: 'category-1' },
      ]),
      categories: createChainableMock([
        { id: 'category-1', name: '仕事', color: 'blue', icon: null },
      ]),
      records: createChainableMock([
        {
          id: 'l1',
          activity_id: 'activity-1',

          source: 'from_plan',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:30:00Z',
        },
        {
          id: 'l2',
          activity_id: 'activity-1',

          source: 'auto_migrated',
          start_at: '2026-07-02T00:00:00Z',
          end_at: '2026-07-02T00:30:00Z',
        },
      ]),
    });

    const result = await service.getEstimationAccuracy(USER_ID);

    // p2 の record は auto_migrated なので実績なし扱い → record_count は p1 のみで 1 件 → HAVING で除外
    expect(result).toMatchObject([
      { avgPlannedMinutes: 45, avgActualMinutes: 60, avgDeviationMinutes: 15, recordCount: 2 },
    ]);
    expect(mockSupabase.from).toHaveBeenCalledWith('plans');
    expect(mockSupabase.from).toHaveBeenCalledWith('records');
  });

  it('未設定と削除済みアクティビティの Plan / Record を同じ未分類 bucket に集計する（#1576 を activity 軸へ踏襲）', async () => {
    const { service } = createService({
      plans: createChainableMock([
        {
          id: 'p-unset',
          activity_id: null,
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T00:30:00Z',
        },
        {
          id: 'p-deleted',
          activity_id: 'deleted-activity-id',
          start_at: '2026-07-02T00:00:00Z',
          end_at: '2026-07-02T00:50:00Z',
        },
      ]),
      activities: createChainableMock([
        { id: 'activity-1', name: 'Deep Work', category_id: 'category-1' },
      ]),
      categories: createChainableMock([
        { id: 'category-1', name: '仕事', color: 'blue', icon: null },
      ]),
      records: createChainableMock([
        {
          id: 'l1',
          activity_id: null,

          source: 'manual',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T00:40:00Z',
        },
        {
          id: 'l2',
          activity_id: 'deleted-activity-id',

          source: 'manual',
          start_at: '2026-07-02T00:00:00Z',
          end_at: '2026-07-02T01:00:00Z',
        },
      ]),
    });

    const result = await service.getEstimationAccuracy(USER_ID);

    expect(result).toEqual([
      {
        activityId: null,
        activityName: null,
        activityColor: null,
        isUncategorized: true,
        avgPlannedMinutes: 40,
        avgActualMinutes: 50,
        avgDeviationMinutes: 10,
        recordCount: 2,
      },
    ]);
  });
});

describe('StatisticsService.getBlankRate', () => {
  it('plans の合計時間から空白率を算出する', async () => {
    const { service } = createService({
      plans: createChainableMock([
        {
          id: 'p1',
          activity_id: 'activity-1',
          start_at: '2026-07-01T00:00:00Z',
          end_at: '2026-07-01T01:00:00Z',
        },
      ]),
    });

    const result = await service.getBlankRate(USER_ID, {
      startDate: '2026-07-01T00:00:00Z',
      endDate: '2026-07-02T00:00:00Z',
      wakeHour: 7,
      sleepHour: 23,
    });

    expect(result).toEqual({
      availableMinutes: 960,
      scheduledMinutes: 60,
      blankMinutes: 900,
      blankRate: 900 / 960,
    });
  });
});
