import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { StatisticsService } from './statistics-service';
import { handleStatsError } from './statistics-shared';

export const statisticsKpiRouter = createTRPCRouter({
  /**
   * 作成時フィードフォワード: タグ別見積もり係数（直近 4 週の中央値、`n >= 3`）
   *
   * Plan を作る瞬間の中核ループ（ADR-026 の 1 点目）に属するため `protectedProcedure` を使う。
   * 利用期間による gate の最終決定は #2605 が持つ。
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
