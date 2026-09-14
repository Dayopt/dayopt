import { TRPCError } from '@trpc/server';

import { logger } from '@/lib/logger';
import { captureUnexpectedError } from '@/lib/sentry';
import { getOriginalError, isExpectedTrpcError } from '@/lib/trpc/errors';

export function handleStatsError(operation: string, error: unknown): never {
  if (error instanceof TRPCError) {
    if (!isExpectedTrpcError(error)) {
      captureUnexpectedError(getOriginalError(error), {
        feature: 'statistics',
        source: 'statistics_router',
        operation,
      });
    }
    throw error;
  }

  const unexpectedError = error instanceof Error ? error : new Error('Unknown statistics error');
  captureUnexpectedError(unexpectedError, {
    feature: 'statistics',
    source: 'statistics_router',
    operation,
  });
  logger.error(`Statistics ${operation} failed`, {
    errorType: unexpectedError.name,
  });

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Failed to fetch statistics (${operation})`,
    cause: unexpectedError,
  });
}
