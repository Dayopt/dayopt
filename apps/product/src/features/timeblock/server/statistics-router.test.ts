import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const serviceMethods = vi.hoisted(() => ({
  getActivityStats: vi.fn(),
  getActivityEstimationFactors: vi.fn(),
}));

vi.mock('./statistics-service', () => ({
  StatisticsService: class {
    getActivityStats = serviceMethods.getActivityStats;
    getActivityEstimationFactors = serviceMethods.getActivityEstimationFactors;
  },
}));

import { statisticsQueriesRouter } from './statistics';

const createCaller = createCallerFactory(statisticsQueriesRouter);
const USER_ID = 'user-1';

function authedCaller() {
  const ctx = Object.assign(createMockContext({ userId: USER_ID }), {
    subscriptionStatus: 'active' as const,
  });
  return createCaller(ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMethods.getActivityStats.mockResolvedValue({ counts: {}, planCounts: {}, lastUsed: {} });
  serviceMethods.getActivityEstimationFactors.mockResolvedValue([]);
});

// 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
// 機械検証する（#2187 E-3）。ここでの個別 assert（getActivityStats）は重複だったため削除した。

describe('statistics router: StatisticsService 委譲', () => {
  it('getActivityStats / getActivityEstimationFactors を service へ渡す', async () => {
    const caller = authedCaller();

    await caller.getActivityStats();
    await caller.getActivityEstimationFactors();

    expect(serviceMethods.getActivityStats).toHaveBeenCalledWith(USER_ID);
    expect(serviceMethods.getActivityEstimationFactors).toHaveBeenCalledWith(USER_ID);
  });

  it('呼び出し元の無かった分布・KPI・streak 系 procedure は公開しない（#2624）', () => {
    const procedures = Object.keys(statisticsQueriesRouter._def.procedures);
    for (const removed of [
      'getStatsOverview',
      'getStreak',
      'getEstimationAccuracy',
      'getBlankRate',
      'getHourlyDistribution',
      'getDayOfWeekDistribution',
      'getMonthlyTrend',
      'getDailyHours',
    ]) {
      expect(procedures).not.toContain(removed);
    }
    expect(procedures).toEqual(
      expect.arrayContaining(['getActivityStats', 'getActivityEstimationFactors', 'getMcpReview']),
    );
  });

  it('service error を INTERNAL_SERVER_ERROR に正規化する', async () => {
    serviceMethods.getActivityStats.mockRejectedValueOnce(new Error('db down'));
    await expect(authedCaller().getActivityStats()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('estimation procedure compatible rename', () => {
  it.each(['getActivityEstimationFactors', 'getTagEstimationFactors'] as const)(
    '%s returns the same user-scoped factors',
    async (name) => {
      const factors = [{ activityId: 'activity-a', factor: 1.5, sampleCount: 4 }];
      serviceMethods.getActivityEstimationFactors.mockResolvedValue(factors);
      await expect(authedCaller()[name]()).resolves.toEqual(factors);
      expect(serviceMethods.getActivityEstimationFactors).toHaveBeenCalledExactlyOnceWith(USER_ID);
    },
  );
  it.each(['getActivityEstimationFactors', 'getTagEstimationFactors'] as const)(
    '%s denies unauthenticated calls before the service',
    async (name) => {
      const caller = createCaller(createMockContext());
      await expect(caller[name]()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(serviceMethods.getActivityEstimationFactors).not.toHaveBeenCalled();
    },
  );
});
