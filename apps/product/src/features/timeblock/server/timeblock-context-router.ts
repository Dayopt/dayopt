import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import { timeblockContextRangeSchema } from './timeblock-context-contract';
import { createTimeblockContextService } from './timeblock-context-service';

export const timeblockContextRouter = createTRPCRouter({
  getConstraints: protectedProcedure
    .meta({ description: 'Current Plan / Record scheduling constraints' })
    .input(timeblockContextRangeSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await createTimeblockContextService().getConstraints(
          ctx.userId,
          input,
          ctx.req.signal,
        );
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
