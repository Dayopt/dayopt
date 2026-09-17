import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { StatisticsService } from './statistics-service';
import { handleStatsError } from './statistics-shared';

/** 作成時フィードフォワードは利用期間によらない中核操作。#2605 がgateの最終決定を持つ。 */
const activityEstimationFactors = protectedProcedure
  .meta({ description: '作成時フィードフォワード（アクティビティ別見積もり係数の中央値）' })
  .query(async ({ ctx }) => {
    try {
      return await new StatisticsService(ctx.supabase).getActivityEstimationFactors(ctx.userId);
    } catch (error) {
      handleStatsError('getActivityEstimationFactors', error);
    }
  });

export const statisticsKpiRouter = createTRPCRouter({
  getActivityEstimationFactors: activityEstimationFactors,
  /** @deprecated #2694: 新名を配信して旧clientの利用を観測するまで維持する。 */
  getTagEstimationFactors: activityEstimationFactors,
});
