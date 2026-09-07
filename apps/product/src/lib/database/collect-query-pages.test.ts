import { PostgrestError } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { collectQueryPages } from './collect-query-pages';

describe('collectQueryPages', () => {
  it('includes rows after the API page limit', async () => {
    const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
    const fetch = vi.fn(async (from: number, to: number) => ({
      data: rows.slice(from, to + 1),
      error: null,
    }));
    expect(await collectQueryPages(fetch)).toEqual({ data: rows, error: null });
    expect(fetch.mock.calls).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });
  it('discards partial totals if a later page fails', async () => {
    const error = new PostgrestError({
      message: 'read failed',
      code: 'XX000',
      details: '',
      hint: '',
    });
    const fetch = vi.fn(async (from: number) =>
      from === 0
        ? { data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null }
        : { data: null, error },
    );
    expect(await collectQueryPages(fetch)).toEqual({ data: [], error });
  });
});
