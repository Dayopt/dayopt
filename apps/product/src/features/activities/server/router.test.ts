import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database';
import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';
import type { Context } from '@/lib/trpc/context';
import { createTRPCRouter } from '@/lib/trpc/router';

import { activitiesRouter } from './router';

// No Redis credentials are needed: exercise the real in-memory limiter.
vi.hoisted(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
});

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const CATEGORY = '20000000-0000-4000-8000-000000000001';
const ACTIVITY = '30000000-0000-4000-8000-000000000001';
const ARCHIVED = '2026-01-01T00:00:00.000Z';
const root = createTRPCRouter({ activities: activitiesRouter });
type Caller = ReturnType<typeof root.createCaller>['activities'];
type DbRow = Record<string, unknown>;
type Exchange = {
  table: string;
  method: string;
  filters: URLSearchParams;
  body: DbRow | undefined;
};

/** Only the external PostgREST HTTP boundary is replaced; router, middleware and services are real.
 * This fixture deliberately has no RLS: removing the application's owner filter exposes the other row.
 * It is not evidence of database RLS / FK enforcement, which belongs to integration tests.
 */
function databaseBoundary() {
  const now = Date.now();
  const rows: Record<string, DbRow[]> = {
    categories: [
      category(CATEGORY, OWNER),
      category('20000000-0000-4000-8000-000000000002', OTHER),
    ],
    activities: [
      activity(ACTIVITY, OWNER),
      activity('30000000-0000-4000-8000-000000000002', OTHER),
    ],
    records: [
      {
        id: '50000000-0000-4000-8000-000000000001',
        user_id: OWNER,
        activity_id: ACTIVITY,
        deleted_at: null,
        title: 'Owned record',
        start_at: new Date(now - 30 * 60_000).toISOString(),
        end_at: new Date(now - 15 * 60_000).toISOString(),
        source: 'manual',
      },
      {
        id: '50000000-0000-4000-8000-000000000002',
        user_id: OTHER,
        activity_id: ACTIVITY,
        deleted_at: null,
        title: 'Other user record',
        start_at: new Date(now - 30 * 60_000).toISOString(),
        end_at: new Date(now - 15 * 60_000).toISOString(),
        source: 'manual',
      },
    ],
  };
  const exchanges: Exchange[] = [];
  let fence = false;
  let errorCode: string | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://mission.invalid' || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
    }
    const table = url.pathname.split('/').at(-1)!;
    const body =
      request.method === 'POST' || request.method === 'PATCH'
        ? ((await request.json()) as DbRow)
        : undefined;
    exchanges.push({ table, method: request.method, filters: url.searchParams, body });
    if (table === 'write_fence_control') return Response.json({ fence_enabled: fence });
    if (table === 'profiles')
      return Response.json({
        subscription_status: 'free',
        app_trial_started_at: null,
        app_trial_ends_at: null,
        app_trial_consumed_at: null,
      });
    if (!rows[table]) throw new Error(`Unexpected table: ${table}`);
    if (errorCode && request.method !== 'GET') {
      return Response.json(
        { code: errorCode, message: 'fixture constraint failure' },
        { status: 409 },
      );
    }
    let selected = rows[table].filter((row) =>
      [...url.searchParams].every(([key, value]) => {
        if (key === 'select' || key === 'order' || key === 'offset' || key === 'limit') return true;
        if (value === 'is.null') return row[key] === null;
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        if (value.startsWith('lt.'))
          return Date.parse(String(row[key])) < Date.parse(value.slice(3));
        if (value.startsWith('gt.'))
          return Date.parse(String(row[key])) > Date.parse(value.slice(3));
        throw new Error(`Unsupported fixture filter: ${key}=${value}`);
      }),
    );
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? selected.length);
    selected = selected.slice(offset, offset + limit);
    if (body && request.method === 'POST') {
      selected = [{ ...category('40000000-0000-4000-8000-000000000001', OWNER), ...body }];
      rows[table].push(...selected);
    }
    if (body && request.method === 'PATCH') for (const row of selected) Object.assign(row, body);
    if (request.method === 'DELETE')
      rows[table] = rows[table].filter((row) => !selected.includes(row));
    const single = request.headers.get('accept')?.includes('application/vnd.pgrst.object+json');
    return Response.json(single ? (selected[0] ?? null) : selected);
  });
  return {
    rows,
    exchanges,
    fetch,
    setFence: () => {
      fence = true;
    },
    failWrites: (code: string) => {
      errorCode = code;
    },
  };
}

function category(id: string, userId: string): DbRow {
  return {
    id,
    user_id: userId,
    name: 'Focus',
    color: 'blue',
    icon: 'book',
    archived_at: null,
    created_at: ARCHIVED,
    updated_at: ARCHIVED,
  };
}
function activity(id: string, userId: string): DbRow {
  return { ...category(id, userId), category_id: userId === OWNER ? CATEGORY : null };
}

let db: ReturnType<typeof databaseBoundary>;
function caller(overrides: Partial<Context> = {}) {
  return root.createCaller({
    req: { headers: {}, cookies: {} },
    res: {},
    requestStartedAt: Date.now(),
    userId: OWNER,
    authMode: 'session',
    mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal1', lookupFailed: false },
    supabase: createClient<Database>('https://mission.invalid', 'fixture-publishable', {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    ...overrides,
  }).activities;
}
const cases: {
  name: keyof Caller;
  call: (api: Caller) => Promise<unknown>;
  table?: string;
  method?: string;
}[] = [
  {
    name: 'listCategories',
    call: (api) => api.listCategories(),
    table: 'categories',
    method: 'GET',
  },
  {
    name: 'listActivities',
    call: (api) => api.listActivities(),
    table: 'activities',
    method: 'GET',
  },
  {
    name: 'getActivitySummary',
    call: (api) => api.getActivitySummary({ activityId: ACTIVITY, timezone: 'UTC' }),
    table: 'records',
    method: 'GET',
  },
  { name: 'listTree', call: (api) => api.listTree() },
  {
    name: 'createCategory',
    call: (api) => api.createCategory({ name: ' New ' }),
    table: 'categories',
    method: 'POST',
  },
  {
    name: 'createActivity',
    call: (api) => api.createActivity({ name: ' New ', categoryId: CATEGORY }),
    table: 'activities',
    method: 'POST',
  },
  {
    name: 'updateCategory',
    call: (api) => api.updateCategory({ id: CATEGORY, name: ' New ', color: null, icon: null }),
    table: 'categories',
    method: 'PATCH',
  },
  {
    name: 'updateActivity',
    call: (api) => api.updateActivity({ id: ACTIVITY, name: ' New ', categoryId: null }),
    table: 'activities',
    method: 'PATCH',
  },
  {
    name: 'archiveCategory',
    call: (api) => api.archiveCategory({ id: CATEGORY }),
    table: 'categories',
    method: 'PATCH',
  },
  {
    name: 'archiveActivity',
    call: (api) => api.archiveActivity({ id: ACTIVITY }),
    table: 'activities',
    method: 'PATCH',
  },
  {
    name: 'restoreCategory',
    call: (api) => api.restoreCategory({ id: CATEGORY }),
    table: 'categories',
    method: 'PATCH',
  },
  {
    name: 'restoreActivity',
    call: (api) => api.restoreActivity({ id: ACTIVITY }),
    table: 'activities',
    method: 'PATCH',
  },
  {
    name: 'deleteCategory',
    call: (api) => api.deleteCategory({ id: CATEGORY }),
    table: 'categories',
    method: 'DELETE',
  },
  {
    name: 'deleteActivity',
    call: (api) => api.deleteActivity({ id: ACTIVITY }),
    table: 'activities',
    method: 'DELETE',
  },
];

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://mission.invalid');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'fixture-service-role');
  vi.stubEnv('BILLING_ENFORCED', 'false');
  db = databaseBoundary();
  vi.stubGlobal('fetch', db.fetch);
  resetWriteFenceCacheForTestsOnly();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetWriteFenceCacheForTestsOnly();
});

describe('activities API: real router / middleware / service with DB HTTP boundary', () => {
  it('covers every registered activity procedure', () => {
    // 守ること: 新規endpointを追加したら正常系・拒否ケースの一覧も更新する。
    expect(cases.map(({ name }) => name).sort()).toEqual(
      Object.keys(activitiesRouter._def.procedures).sort(),
    );
  });

  it.each(cases)(
    '$name: successful request changes/returns only the owner data',
    async ({ name, call, table, method }) => {
      // 守ること: APIの正常入力が実Serviceを通り、本人の返却値・書込内容に反映される。
      if (name.startsWith('restore')) db.rows[table!]![0]!.archived_at = ARCHIVED;
      const operation = call(caller());
      await expect(operation).resolves.toBeDefined();
      const result = await operation;
      if (name === 'getActivitySummary') {
        expect(result).toMatchObject({
          totalRecordCount: 1,
          recordedMinutes: 15,
          records: [expect.objectContaining({ title: 'Owned record' })],
        });
        expect(JSON.stringify(result)).not.toContain(OTHER);
      } else if (name === 'listTree') {
        expect(result).toMatchObject({
          categories: [{ category: { id: CATEGORY }, activities: [{ id: ACTIVITY }] }],
          uncategorized: [],
        });
        expect(JSON.stringify(result)).not.toContain(OTHER);
      } else if (method === 'GET') {
        expect(result).toEqual([expect.objectContaining({ user_id: OWNER })]);
      } else if (method === 'DELETE') {
        expect(result).toMatchObject({
          id: table === 'categories' ? CATEGORY : ACTIVITY,
          user_id: OWNER,
        });
        expect(db.rows[table!]).toEqual([expect.objectContaining({ user_id: OTHER })]);
      } else if (name.startsWith('archive')) {
        expect(result).toMatchObject({
          archived_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          user_id: OWNER,
        });
      } else if (name.startsWith('restore')) {
        expect(result).toMatchObject({ archived_at: null, user_id: OWNER });
      } else {
        expect(result).toMatchObject({ name: 'New', user_id: OWNER });
      }
      const operations = db.exchanges.filter((entry) => entry.table !== 'write_fence_control');
      expect(operations.length).toBeGreaterThan(0);
      for (const entry of operations) {
        if (entry.method === 'POST') expect(entry.body?.user_id).toBe(OWNER);
        else expect(entry.filters.get('user_id')).toBe(`eq.${OWNER}`);
      }
      if (table && method)
        expect(operations).toContainEqual(expect.objectContaining({ table, method }));
      if (name === 'createActivity') expect(result).toMatchObject({ category_id: CATEGORY });
      if (name === 'updateActivity') expect(result).toMatchObject({ category_id: null });
      if (name === 'updateCategory') expect(result).toMatchObject({ color: null, icon: null });
    },
  );

  it.each(cases)('$name: unauthenticated request never reaches DB', async ({ call }) => {
    // 守ること: 全endpointが未認証ユーザーを拒否し、読取も書込も開始しない。
    await expect(call(caller({ userId: undefined }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(db.exchanges).toEqual([]);
  });

  it.each(cases)('$name: MFA challenge cannot be bypassed', async ({ call }) => {
    // 守ること: MFA未完了のsessionは正常な入力でもDB操作へ到達しない。
    await expect(
      call(
        caller({ mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal2', lookupFailed: false } }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.exchanges).toEqual([]);
  });

  it.each(cases)('$name: public OAuth callers cannot use session endpoints', async ({ call }) => {
    // 守ること: scopeを持つOAuth tokenでも公開tRPCからデータへ到達しない。
    await expect(
      call(caller({ authMode: 'oauth', oauthScopes: ['read:activities'] })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.exchanges).toEqual([]);
  });

  it.each(cases.filter(({ method }) => method === 'POST' || method === 'PATCH'))(
    '$name: expired access cannot write',
    async ({ call }) => {
      // 守ること: 利用権がないユーザーの作成・編集・アーカイブ・復元をDB書込前に拒否する。
      vi.stubEnv('BILLING_ENFORCED', 'true');
      await expect(call(caller())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'BILLING_ACCESS_ENDED' },
      });
      expect(db.exchanges.map(({ table }) => table)).toEqual(['profiles']);
      expect(db.exchanges[0]?.filters.get('id')).toBe(`eq.${OWNER}`);
    },
  );

  it.each(cases.filter(({ method }) => method && method !== 'GET'))(
    '$name: write fence stops writes',
    async ({ call }) => {
      // 守ること: メンテナンス停止中にDB mutationを実行しない。
      db.setFence();
      await expect(call(caller())).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        cause: { code: 'WRITE_FENCED' },
      });
      expect(db.exchanges.map(({ table }) => table)).toEqual(['write_fence_control']);
    },
  );

  it.each(cases.filter(({ method }) => method === 'PATCH' || method === 'DELETE'))(
    '$name: another owner cannot mutate the target',
    async ({ call }) => {
      // 守ること: 存在する他人のIDを指定してもNOT_FOUNDとなり、特権書込へ進まない。
      await expect(call(caller({ userId: OTHER }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.exchanges.every(({ method }) => method === 'GET')).toBe(true);
      expect(db.rows.categories![0]?.name).toBe('Focus');
      expect(db.rows.activities![0]?.name).toBe('Focus');
    },
  );

  it.each([
    ['createCategory', { name: '' }],
    ['createCategory', { name: 'a'.repeat(51) }],
    ['createCategory', { name: 'ok', color: 'not-a-color' }],
    ['createCategory', { name: 'ok', icon: '<script>' }],
    ['createActivity', { name: '' }],
    ['createActivity', { name: 'ok', categoryId: 'bad-id' }],
    ['updateCategory', { id: CATEGORY, name: '' }],
    ['updateActivity', { id: ACTIVITY, categoryId: 'bad-id' }],
    ...[
      'archiveCategory',
      'restoreCategory',
      'deleteCategory',
      'archiveActivity',
      'restoreActivity',
      'deleteActivity',
    ].map((name) => [name, { id: 'bad-id' }] as const),
    ['listCategories', { includeArchived: 'true' }],
    ['listActivities', { includeArchived: 1 }],
  ] as const)('%s rejects invalid input %j', async (name, input) => {
    // 守ること: 不正な名前・UUID・enum・型がDBクエリへ到達しない。
    const invoke = caller()[name as keyof Caller] as (value: unknown) => Promise<unknown>;
    await expect(invoke(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.exchanges.filter(({ table }) => table !== 'write_fence_control')).toEqual([]);
  });

  it.each(['createCategory', 'createActivity'] as const)(
    '%s accepts a 50-character name',
    async (name) => {
      // 守ること: 許可された最大長の名前をAPIとServiceの両方が受け付ける。
      await expect(caller()[name]({ name: 'a'.repeat(50) })).resolves.toMatchObject({
        name: 'a'.repeat(50),
        user_id: OWNER,
      });
    },
  );

  it.each(['createCategory', 'createActivity'] as const)(
    '%s rejects whitespace-only names in the real service',
    async (name) => {
      // 守ること: Zodの文字数検査を通る空白だけの名前もServiceが拒否する。
      await expect(caller()[name]({ name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.exchanges.some(({ method }) => method === 'POST')).toBe(false);
    },
  );

  it.each(['createActivity', 'updateActivity'] as const)(
    '%s cannot assign an archived category',
    async (name) => {
      // 守ること: アーカイブ済みカテゴリーへの新規割当・移動は保存されない。
      db.rows.categories![0]!.archived_at = ARCHIVED;
      const api = caller();
      const operation =
        name === 'createActivity'
          ? api.createActivity({ name: 'New', categoryId: CATEGORY })
          : api.updateActivity({ id: ACTIVITY, categoryId: CATEGORY });
      await expect(operation).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.exchanges.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it.each(['createCategory', 'createActivity'] as const)(
    '%s translates duplicate-name DB failures',
    async (name) => {
      // 守ること: DB一意制約違反を既存契約どおりBAD_REQUESTとDUPLICATE_NAMEでAPIへ伝える。
      db.failWrites('23505');
      await expect(caller()[name]({ name: 'New' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'DUPLICATE_NAME' },
      });
      expect(db.exchanges.some(({ method }) => method === 'POST')).toBe(true);
    },
  );

  it('listTree keeps active activities visible after their category is archived', async () => {
    // 守ること: カテゴリーのアーカイブだけで現役アクティビティを画面から消さない。
    db.rows.categories![0]!.archived_at = ARCHIVED;
    await expect(caller().listTree()).resolves.toMatchObject({
      categories: [],
      uncategorized: [{ id: ACTIVITY }],
    });
  });

  it.each(['listCategories', 'listActivities'] as const)(
    '%s includes archived data only on explicit request',
    async (name) => {
      // 守ること: 既定ではアーカイブを隠し、明示フラグだけで本人の履歴を返す。
      db.rows[name === 'listCategories' ? 'categories' : 'activities']![0]!.archived_at = ARCHIVED;
      await expect(caller()[name]()).resolves.toEqual([]);
      await expect(caller()[name]({ includeArchived: true })).resolves.toEqual([
        expect.objectContaining({ user_id: OWNER, archived_at: ARCHIVED }),
      ]);
    },
  );

  it('getActivitySummary scopes records to the authenticated user', async () => {
    const result = await caller().getActivitySummary({ activityId: ACTIVITY, timezone: 'UTC' });

    expect(result).toMatchObject({ totalRecordCount: 1, recordedMinutes: 15 });
    expect(result.records).toEqual([expect.objectContaining({ title: 'Owned record' })]);
    expect(db.exchanges.filter(({ table }) => table === 'records')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
  });
});
