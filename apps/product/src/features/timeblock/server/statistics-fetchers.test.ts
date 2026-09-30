import { describe, expect, it } from 'vitest';

import { createChainableMock, createMockSupabase } from '@/lib/test/trpc-test-helpers';

import { fetchRecords } from './statistics-fetchers';
import type { ServiceSupabaseClient } from './types';

const rows = [
  {
    id: 'lower',
    activity_id: 'a',
    source: 'manual',
    start_at: '2026-08-07T23:30:00.000Z',
    end_at: '2026-08-08T00:30:00.000Z',
  },
  {
    id: 'upper',
    activity_id: 'a',
    source: 'manual',
    start_at: '2026-08-09T23:30:00.000Z',
    end_at: '2026-08-10T00:30:00.000Z',
  },
];
const range = { startDate: '2026-08-08T00:00:00.000Z', endDate: '2026-08-10T00:00:00.000Z' };

function client() {
  const query = createChainableMock(rows);
  const supabase = createMockSupabase();
  supabase.from.mockReturnValue(query);
  return { supabase: supabase as unknown as ServiceSupabaseClient, query };
}

describe('fetchRecords duration boundaries', () => {
  it('keeps period clipping by default for aggregate and estimation callers', async () => {
    const { supabase } = client();
    const result = await fetchRecords(supabase, 'user-a', range);
    expect(result.map(({ start_at, end_at }) => [start_at, end_at])).toEqual([
      ['2026-08-08T00:00:00.000Z', '2026-08-08T00:30:00.000Z'],
      ['2026-08-09T23:30:00.000Z', '2026-08-10T00:00:00.000Z'],
    ]);
  });

  it('can retain real Record duration while keeping owner/deletion/overlap filters', async () => {
    const { supabase, query } = client();
    const result = await fetchRecords(supabase, 'user-a', range, { clipToRange: false });
    expect(result).toEqual(rows);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-a');
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(query.gt).toHaveBeenCalledWith('end_at', '2026-08-08T00:00:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('start_at', '2026-08-10T00:00:00.000Z');
  });
});
