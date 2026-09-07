import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';

import { fetchPlans, fetchRecords } from './statistics-fetchers';
import type { ServiceSupabaseClient } from './types';

const mocks = vi.hoisted(() => ({
  captureUnexpectedDatabaseError: vi.fn(),
  normalizedError: new Error('normalized database error'),
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: mocks.captureUnexpectedDatabaseError,
}));
vi.mock('@/lib/server/user-timezone-cache', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
}));

const DATABASE_ERROR = { code: 'XX000', message: 'private database detail' };
const USER_ID = 'user-1';

function clientFor(tableData: Record<string, ReturnType<typeof createChainableMock>>) {
  const supabase = createMockSupabase();
  supabase.from.mockImplementation((table: string) => {
    const query = tableData[table];
    if (!query) throw new Error(`Unexpected test table: ${table}`);
    return query;
  });
  return supabase as unknown as ServiceSupabaseClient;
}

describe('statistics fetcher observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureUnexpectedDatabaseError.mockReturnValue(mocks.normalizedError);
  });

  it.each([
    ['fetch_records', (client: ServiceSupabaseClient) => fetchRecords(client, USER_ID)],
    ['fetch_plans', (client: ServiceSupabaseClient) => fetchPlans(client, USER_ID)],
  ])('%sは元DB障害を一度captureしてnormalized errorをthrowする', async (operation, run) => {
    const query = createChainableMock([], DATABASE_ERROR);
    const client = clientFor({ plans: query, records: query });

    await expect(run(client)).rejects.toBe(mocks.normalizedError);
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledOnce();
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledWith(DATABASE_ERROR, {
      feature: 'statistics',
      operation,
    });
  });
});
