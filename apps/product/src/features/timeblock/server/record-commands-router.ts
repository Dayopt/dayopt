import { z } from 'zod';

import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { createRecordSchema, recordIdSchema, updateRecordSchema } from '../schemas/timeblock';
import { createTimeblockCommandService } from './timeblock-command-service';

/**
 * owner 境界は「`.strict()` + service へ渡す field の明示」で機械保証する。
 * 経緯と理由は plan-commands-router.ts の同じ位置のコメントを正とする（#2627）。
 */
const versionedRecordSchema = recordIdSchema
  .extend({
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const recordCommandsRouter = createTRPCRouter({
  create: protectedProcedure
    .meta({ description: 'Create Record through the atomic command boundary' })
    .input(createRecordSchema)
    .mutation(async ({ ctx, input }) => {
      const service = createTimeblockCommandService(ctx.supabase);
      try {
        return await service.createRecord({ userId: ctx.userId, input });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  update: protectedProcedure
    .meta({ description: 'Update Record through the versioned atomic command boundary' })
    .input(
      versionedRecordSchema.extend({
        data: updateRecordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = createTimeblockCommandService(ctx.supabase);
      try {
        return await service.updateRecord({
          userId: ctx.userId,
          id: input.id,
          input: input.data,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  delete: protectedProcedure
    .meta({ description: 'Soft-delete Record through the versioned atomic command boundary' })
    .input(versionedRecordSchema)
    .mutation(async ({ ctx, input }) => {
      const service = createTimeblockCommandService(ctx.supabase);
      try {
        return await service.deleteRecord({
          userId: ctx.userId,
          id: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  restore: protectedProcedure
    .meta({ description: 'Restore Record through the versioned atomic command boundary' })
    .input(versionedRecordSchema)
    .mutation(async ({ ctx, input }) => {
      const service = createTimeblockCommandService(ctx.supabase);
      try {
        return await service.restoreRecord({
          userId: ctx.userId,
          id: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
