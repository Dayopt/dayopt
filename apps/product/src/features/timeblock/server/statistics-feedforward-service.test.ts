import { describe, expect, it } from 'vitest';

import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';

import {
  ESTIMATION_WINDOW_DAYS,
  StatisticsFeedforwardService,
} from './statistics-feedforward-service';
import type { ServiceSupabaseClient } from './types';

const USER_ID = 'user-feedforward-1';
const NOW = new Date('2026-08-07T12:00:00.000Z');

function createService(
  plans: ReadonlyArray<Record<string, unknown>>,
  records: ReadonlyArray<Record<string, unknown>>,
) {
  const plansMock = createChainableMock(plans);
  const recordsMock = createChainableMock(records);
  const mockSupabase = createMockSupabase();
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'plans') return plansMock;
    if (table === 'records') return recordsMock;
    throw new Error(`Unexpected table access in test: ${table}`);
  });
  return {
    plansMock,
    recordsMock,
    service: new StatisticsFeedforwardService(mockSupabase as unknown as ServiceSupabaseClient),
  };
}

/** 予定 60 分 / 実績 90 分 の Plan-Record ペアを n 件作る（比 1.5）。 */
function buildPair(index: number, actualMinutes = 90) {
  const day = String(index + 1).padStart(2, '0');
  return {
    plan: {
      id: `plan-${index}`,
      activity_id: 'activity-a',
      start_at: `2026-08-${day}T09:00:00.000Z`,
      end_at: `2026-08-${day}T10:00:00.000Z`,
    },
    record: {
      id: `record-${index}`,
      activity_id: 'activity-a',
      source: 'from_plan',
      start_at: `2026-08-${day}T09:00:00.000Z`,
      end_at: new Date(
        new Date(`2026-08-${day}T09:00:00.000Z`).getTime() + actualMinutes * 60_000,
      ).toISOString(),
    },
  };
}

describe('StatisticsFeedforwardService', () => {
  it('4 週窓は plan.start_at の [28 日前, now) で切る（record の発生時刻では切らない）', async () => {
    const { plansMock, service } = createService([], []);

    await service.getTagEstimationFactors(USER_ID, NOW);

    // 過去 Plan への遅延記録があっても、窓は Plan 側の start_at だけで決まる。
    // record 側で切ると「4 週前の Plan を昨日記録した」比が窓に入り、
    // 「直近 4 週の見積もり傾向」ではなくなる。
    const expectedStart = new Date(
      NOW.getTime() - ESTIMATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(plansMock.gt).toHaveBeenCalledWith('end_at', expectedStart);
    expect(plansMock.lt).toHaveBeenCalledWith('start_at', NOW.toISOString());
    expect(plansMock.gt).toHaveBeenCalledTimes(1);
    expect(plansMock.lt).toHaveBeenCalledTimes(1);
  });

  it('窓は 28 日（ADR-026 の「直近 4 週」）', () => {
    expect(ESTIMATION_WINDOW_DAYS).toBe(28);
  });

  it('Plan が 0 件なら records を引かずに空配列を返す', async () => {
    const { recordsMock, service } = createService([], []);

    await expect(service.getTagEstimationFactors(USER_ID, NOW)).resolves.toEqual([]);
    expect(recordsMock.select).not.toHaveBeenCalled();
  });

  it('start_at / end_at から予定・実績の分数を導いて係数を返す', async () => {
    const pairs = [buildPair(0), buildPair(1), buildPair(2)];
    const { service } = createService(
      pairs.map((pair) => pair.plan),
      pairs.map((pair) => pair.record),
    );

    await expect(service.getTagEstimationFactors(USER_ID, NOW)).resolves.toEqual([
      { activityId: 'activity-a', factor: 1.5, sampleCount: 3 },
    ]);
  });

  it('取得した Plan の id だけを使って records を引く', async () => {
    const pairs = [buildPair(0), buildPair(1), buildPair(2)];
    const { recordsMock, service } = createService(
      pairs.map((pair) => pair.plan),
      pairs.map((pair) => pair.record),
    );

    await service.getTagEstimationFactors(USER_ID, NOW);

    expect(recordsMock.gt).toHaveBeenCalledWith('end_at', expect.any(String));
    expect(recordsMock.lt).toHaveBeenCalledWith('start_at', NOW.toISOString());
  });
});
