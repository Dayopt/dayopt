import { z } from 'zod';

import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { StatisticsService } from './statistics-service';
import { dateRangeInput, handleStatsError } from './statistics-shared';

export const statisticsKpiRouter = createTRPCRouter({
  /** 見積もり精度: タグ別の予定時間 vs 実績時間 */
  getEstimationAccuracy: protectedProcedure
    .meta({ description: '見積もり精度KPI（タグ別の予定vs実績）' })
    .input(dateRangeInput)
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getEstimationAccuracy(ctx.userId, input);
      } catch (error) {
        handleStatsError('getEstimationAccuracy', error);
      }
    }),

  /** 空白率: 活動可能時間のうちスケジュールされていない時間の割合 */
  getBlankRate: protectedProcedure
    .meta({ description: '空白率KPI（未スケジュール時間の割合）' })
    .input(
      dateRangeInput.extend({
        wakeHour: z.number().min(0).max(23).default(7),
        sleepHour: z.number().min(0).max(23).default(23),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await new StatisticsService(ctx.supabase).getBlankRate(ctx.userId, input);
      } catch (error) {
        handleStatsError('getBlankRate', error);
      }
    }),

  /**
   * 作成時フィードフォワード: タグ別見積もり係数（直近 4 週の中央値、`n >= 3`）
   *
   * `protectedProcedure` を使う。同じ statistics router 内でも Pro 区分は分かれており、
   * Calendar の常設導線が引くもの（`getTagStats` / `getStreak`）は protected、
   * 分析深度にあたるもの（`getEstimationAccuracy` / `getStatsOverview`）は pro になっている。
   * 本 procedure は Plan を作る瞬間の中核ループ（ADR-026 の 1 点目）に属するため前者に揃える。
   * Free / Pro 境界の最終決定は #1336 が持つ（レポート面の境界は #2605）。
   */
  getTagEstimationFactors: protectedProcedure
    .meta({ description: '作成時フィードフォワード（タグ別見積もり係数の中央値）' })
    .query(async ({ ctx }) => {
      try {
        return await new StatisticsService(ctx.supabase).getTagEstimationFactors(ctx.userId);
      } catch (error) {
        handleStatsError('getTagEstimationFactors', error);
      }
    }),
});
