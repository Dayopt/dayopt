import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTimeblockReviewClient } from './timeblock-review-client';

interface QueryCall {
  method: string;
  args: unknown[];
}

const from = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({ from }),
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: (error: unknown) =>
    error instanceof Error ? error : new Error('database read failed'),
}));

const USER_ID = '00000000-0000-4000-8000-000000000001';
const ACTIVITY_ID = '00000000-0000-4000-8000-000000000002';

/** PostgRESTのbuilderを模したthenable double。適用されたfilterを記録する。 */
function createQueryDouble(result: {
  data: unknown[] | null;
  error: unknown;
  count?: number | null;
}) {
  const calls: QueryCall[] = [];
  const query: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ count: null, ...result }).then(resolve),
  };
  for (const method of ['eq', 'is', 'not', 'gt', 'lt', 'order', 'range', 'abortSignal']) {
    query[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return query;
    });
  }
  return { calls, query };
}

function mockPage(result: { data: unknown[] | null; error: unknown; count?: number | null }) {
  const double = createQueryDouble(result);
  const select = vi.fn(() => double.query);
  from.mockReturnValue({ select });
  return { ...double, select };
}

function listInput(overrides: Partial<{ offset: number; limit: number }> = {}) {
  return {
    userId: USER_ID,
    lane: 'plans' as const,
    startDate: '2026-07-20T00:00:00+09:00',
    endDate: '2026-07-27T00:00:00+09:00',
    offset: 0,
    limit: 1_000,
    ...overrides,
  };
}

describe('TimeblockReviewClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tag有無で絞らず未分類行もreview対象として返す', async () => {
    const page = mockPage({
      data: [
        { id: 'plan-1', activity_id: ACTIVITY_ID, start_at: '2026-07-20T01:00:00Z', end_at: '...' },
        { id: 'plan-2', activity_id: null, start_at: '2026-07-20T02:00:00Z', end_at: '...' },
      ],
      error: null,
      count: 2,
    });

    await expect(createTimeblockReviewClient().listReviewPage(listInput())).resolves.toEqual({
      rows: [
        { id: 'plan-1', activityId: ACTIVITY_ID, startAt: '2026-07-20T01:00:00Z', endAt: '...' },
        { id: 'plan-2', activityId: null, startAt: '2026-07-20T02:00:00Z', endAt: '...' },
      ],
      totalCount: 2,
    });

    // `.not('activity_id', 'is', null)` を戻すと、アクティビティ削除のたびに過去の時間が
    // review から目減りする（#1576）。filter 一式を丸ごと固定して回帰を止める。
    expect(page.calls.filter(({ method }) => method === 'not')).toEqual([]);
    expect(page.calls.filter(({ method }) => ['eq', 'is', 'gt', 'lt'].includes(method))).toEqual([
      { method: 'eq', args: ['user_id', USER_ID] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'gt', args: ['end_at', '2026-07-20T00:00:00+09:00'] },
      { method: 'lt', args: ['start_at', '2026-07-27T00:00:00+09:00'] },
    ]);
  });

  it('未分類しか無いページでも例外にせずそのまま返す', async () => {
    mockPage({
      data: [
        { id: 'record-1', activity_id: null, start_at: '2026-07-20T01:00:00Z', end_at: '...' },
      ],
      error: null,
      count: 1,
    });

    await expect(
      createTimeblockReviewClient().listReviewPage(listInput({ offset: 0 })),
    ).resolves.toMatchObject({
      rows: [{ id: 'record-1', activityId: null }],
    });
  });

  it('read失敗はFETCH_FAILEDのまま残す', async () => {
    mockPage({ data: null, error: new Error('boom') });

    await expect(createTimeblockReviewClient().listReviewPage(listInput())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
  });
});
