import { z } from 'zod';

import { handleServiceError } from '@/lib/trpc/errors';

import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { calculateStreak } from '../domain';

import { StatisticsService } from './statistics-service';
import {
  dateRangeInput,
  getTodayInTimezone,
  getUserTimezone,
  handleStatsError,
} from './statistics-shared';
import { timeblockContextRangeSchema } from './timeblock-context-contract';
import { createTimeblockReviewService } from './timeblock-review-service';

export const statisticsSummaryRouter = createTRPCRouter({
  /** 連続アクティブ日数（streak）を計算 */
  getStreak: protectedProcedure
    .meta({ description: '連続アクティブ日数（ストリーク）取得' })
    .query(async ({ ctx }) => {
      try {
        const { supabase, userId } = ctx;

        // ユーザーのタイムゾーンで「今日」を決定する
        const timezone = await getUserTimezone(supabase, userId);
        const todayStr = getTodayInTimezone(timezone);

        // 過去365日分のアクティブ日を取得
        const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

        const activeDates = await new StatisticsService(supabase).getActiveDates(
          userId,
          since.toISOString(),
        );

        const streak = calculateStreak({
          activeDates,
          todayStr,
          timezone,
        });

        return { streak };
      } catch (error) {
        handleStatsError('getStreak', error);
      }
    }),

  // ---------------------------------------------------------------------------
  // Unified KPI Summary (7 RPCs → 1 round-trip)
  // ---------------------------------------------------------------------------

  /** 全KPIを1クエリで取得 */
  getStatsOverview: protectedProcedure
    .meta({ description: '全KPIサマリー一括取得（7指標を1クエリ）' })
    .input(
      dateRangeInput.extend({
        wakeHour: z.number().min(0).max(23).default(7),
        sleepHour: z.number().min(0).max(23).default(23),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getStatsOverview(ctx.userId, input);
      } catch (error) {
        handleStatsError('getStatsOverview', error);
      }
    }),

  /** 外部AI向けの最小・決定論的なPlan / Record review */
  getMcpReview: protectedProcedure
    .meta({ description: 'MCP Time P/L review取得' })
    .input(timeblockContextRangeSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createTimeblockReviewService().getMcpReview(ctx.userId, input, ctx.req.signal);
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
