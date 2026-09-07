import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { planFilterSchema, planIdSchema } from '../schemas/timeblock';
import { createPlanService } from './service-index';

/**
 * Plan の read 専用 router。
 *
 * 書き込みは `planCommands.*`（`TimeblockCommandService`）に一本化済みで、
 * legacy mutation は #1893 で削除した。read は UI と MCP read tool が使うため残す。
 */
export const plansRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({ description: 'Plan list for the split time model' })
    .input(planFilterSchema.optional())
    .query(async ({ ctx, input }) => {
      const service = createPlanService(ctx.supabase);
      try {
        // userId は必ず spread の後に置く（filter に userId 名の field が生えても ctx が勝つ）
        return await service.list({ ...input, userId: ctx.userId });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  getById: protectedProcedure
    .meta({ description: 'Plan detail for the split time model' })
    .input(planIdSchema)
    .query(async ({ ctx, input }) => {
      const service = createPlanService(ctx.supabase);
      try {
        return await service.getById({ userId: ctx.userId, planId: input.id });
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
