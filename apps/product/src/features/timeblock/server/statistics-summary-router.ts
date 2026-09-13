import { handleServiceError } from '@/lib/trpc/errors';

import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { timeblockContextRangeSchema } from './timeblock-context-contract';
import { createTimeblockReviewService } from './timeblock-review-service';

export const statisticsSummaryRouter = createTRPCRouter({
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
