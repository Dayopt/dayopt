import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { recordFilterSchema, recordIdSchema } from '../schemas/timeblock';
import { createRecordService } from './service-index';

/**
 * Record の read 専用 router。
 *
 * 書き込みは `recordCommands.*`（`TimeblockCommandService`）に一本化済みで、
 * legacy mutation は #1893 で削除した。read は UI と MCP read tool が使うため残す。
 */
export const recordsRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({ description: 'Record list for the split time model' })
    .input(recordFilterSchema.optional())
    .query(async ({ ctx, input }) => {
      const service = createRecordService(ctx.supabase);
      try {
        // userId は必ず spread の後に置く（filter に userId 名の field が生えても ctx が勝つ）
        return await service.list({ ...input, userId: ctx.userId });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  getById: protectedProcedure
    .meta({ description: 'Record detail for the split time model' })
    .input(recordIdSchema)
    .query(async ({ ctx, input }) => {
      const service = createRecordService(ctx.supabase);
      try {
        return await service.getById({ userId: ctx.userId, recordId: input.id });
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
