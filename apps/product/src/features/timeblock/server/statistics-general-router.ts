import { z } from 'zod';

import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { StatisticsService } from './statistics-service';
import { dateRangeInput, handleStatsError } from './statistics-shared';

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

  /** Get daily hours for heatmap (DB function) */
  getDailyHours: protectedProcedure
    .meta({ description: '日別記録時間取得（ヒートマップ用）' })
    .input(z.object({ year: z.number().int().min(2000).max(2100) }))
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getDailyHours(ctx.userId, input.year);
      } catch (error) {
        handleStatsError('getDailyHours', error);
      }
    }),

  /** Get hourly distribution (DB function) */
  getHourlyDistribution: protectedProcedure
    .meta({ description: '時間帯別分布取得（2時間スロット）' })
    .input(dateRangeInput.optional())
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getHourlyDistribution(ctx.userId, input);
      } catch (error) {
        handleStatsError('getHourlyDistribution', error);
      }
    }),

  /** Get day of week distribution (DB function) */
  getDayOfWeekDistribution: protectedProcedure
    .meta({ description: '曜日別分布取得（月曜始まり）' })
    .input(dateRangeInput.optional())
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getDayOfWeekDistribution(
          ctx.userId,
          input,
        );
      } catch (error) {
        handleStatsError('getDayOfWeekDistribution', error);
      }
    }),

  /** Get monthly trend (DB function) */
  getMonthlyTrend: protectedProcedure
    .meta({ description: '月別トレンド取得（デフォルト12ヶ月）' })
    .input(z.object({ months: z.number().min(1).max(120).optional() }).optional())
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getMonthlyTrend(ctx.userId, input?.months);
      } catch (error) {
        handleStatsError('getMonthlyTrend', error);
      }
    }),
});
