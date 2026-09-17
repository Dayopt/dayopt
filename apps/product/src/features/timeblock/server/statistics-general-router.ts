import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { StatisticsService } from './statistics-service';
import { handleStatsError } from './statistics-shared';

export const statisticsGeneralRouter = createTRPCRouter({
  /** Get activity statistics (record count, last used date and median duration) */
  getActivityStats: protectedProcedure
    .meta({ description: 'アクティビティ別統計取得（実績件数・最終使用日・記録の長さの中央値）' })
    .query(async ({ ctx }) => {
      try {
        return await new StatisticsService(ctx.supabase).getActivityStats(ctx.userId);
      } catch (error) {
        handleStatsError('getActivityStats', error);
      }
    }),
});
