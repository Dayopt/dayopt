import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * event-pruning.ts のテスト。
 *
 * overview.md §13 の必須 regression（prune anti-join）はここが正本。sync の window prune /
 * 選択解除 / disconnect の 3 経路が共有する不変条件を凍結する。
 */

const createClient = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn((error: unknown) => error));
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-key',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedDatabaseError, captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
}));

import { deleteUnreferencedEvents } from './event-pruning';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';

// event-pruning.ts の PRUNE_BATCH_SIZE と同値。batch 上限テストで全バッチを満杯にするために使う。
const PRUNE_BATCH_SIZE = 150;

type Recorder = { table: string; chain: Array<{ method: string; args: unknown[] }> };

type Config = {
  candidates?: Array<{ id: string }>;
  referencedByPlans?: Array<{ external_calendar_event_id: string | null }>;
  referencedByRecords?: Array<{ external_calendar_event_id: string | null }>;
  selectError?: unknown;
  referencedError?: unknown;
  deleteError?: unknown;
  /** 常に PRUNE_BATCH_SIZE 件満杯を返し続ける（batch 上限に到達させる）。 */
  alwaysFullBatch?: boolean;
  /**
   * 指定バッチ数だけ満杯を返し、その次のバッチで空を返して自然終了させる
   * （connection scope の高い上限でも throw せず完走することを確認するために使う）。
   */
  fullBatchesThenStop?: number;
};

function setupDb(config: Config) {
  const calls: Recorder[] = [];
  let candidateBatch = 0;

  function resolve(recorder: Recorder): { data: unknown; error: unknown } {
    const methods = recorder.chain.map((entry) => entry.method);
    if (recorder.table === 'external_calendar_events') {
      if (methods.includes('delete')) return { data: null, error: config.deleteError ?? null };
      const batch = candidateBatch;
      candidateBatch += 1;
      if (config.alwaysFullBatch) {
        return {
          data: Array.from({ length: PRUNE_BATCH_SIZE }, (_, i) => ({ id: `ev-${batch}-${i}` })),
          error: null,
        };
      }
      if (config.fullBatchesThenStop !== undefined) {
        return {
          data:
            batch < config.fullBatchesThenStop
              ? Array.from({ length: PRUNE_BATCH_SIZE }, (_, i) => ({ id: `ev-${batch}-${i}` }))
              : [],
          error: null,
        };
      }
      return {
        data: batch === 0 ? (config.candidates ?? []) : [],
        error: config.selectError ?? null,
      };
    }
    if (recorder.table === 'plans')
      return {
        data: config.referencedError ? null : (config.referencedByPlans ?? []),
        error: config.referencedError ?? null,
      };
    if (recorder.table === 'records')
      return { data: config.referencedByRecords ?? [], error: null };
    return { data: [], error: null };
  }

  const from = vi.fn((table: string) => {
    const recorder: Recorder = { table, chain: [] };
    calls.push(recorder);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (
              onF: (v: { data: unknown; error: unknown }) => unknown,
              onR?: (e: unknown) => unknown,
            ) => Promise.resolve(resolve(recorder)).then(onF, onR);
          }
          return (...args: unknown[]) => {
            recorder.chain.push({ method: prop, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  });

  createClient.mockReturnValue({ from });
  return { calls, from };
}

function candidateSelect(calls: Recorder[]): Recorder | undefined {
  return calls.find(
    (r) => r.table === 'external_calendar_events' && r.chain.some((e) => e.method === 'select'),
  );
}

function deleteCall(calls: Recorder[]): Recorder | undefined {
  return calls.find(
    (r) => r.table === 'external_calendar_events' && r.chain.some((e) => e.method === 'delete'),
  );
}

function argsOf(recorder: Recorder, method: string): unknown[] {
  const entry = recorder.chain.find((e) => e.method === method);
  if (!entry) throw new Error(`${method} not called`);
  return entry.args;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deleteUnreferencedEvents — anti-join', () => {
  // regression（overview.md §13）: plans / records から参照される行を消さない。
  // soft-delete 済み plan もまだ FK でミラー行を掴んでいるので除外する。
  it('参照済み行（soft-deleted plan 参照を含む）を delete から除外する', async () => {
    const { calls } = setupDb({
      candidates: [{ id: 'ev-1' }, { id: 'ev-2' }, { id: 'ev-3' }],
      referencedByPlans: [{ external_calendar_event_id: 'ev-1' }], // soft-deleted plan の参照
      referencedByRecords: [{ external_calendar_event_id: 'ev-2' }],
    });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'connection' },
    });

    const del = deleteCall(calls);
    expect(del).toBeDefined();
    expect(argsOf(del!, 'in')).toEqual(['id', ['ev-3']]);
    // service_role は RLS を bypass するので delete に user_id ガードが載る
    expect(argsOf(del!, 'eq')).toEqual(['user_id', USER_ID]);

    // 参照クエリは deleted_at で絞らない（soft-deleted も FK を掴む）
    const plans = calls.find((r) => r.table === 'plans');
    expect(plans?.chain.some((e) => e.method === 'is')).toBe(false);
  });

  it('候補が空なら delete を発行しない', async () => {
    const { calls } = setupDb({ candidates: [] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'connection' },
    });

    expect(deleteCall(calls)).toBeUndefined();
  });

  it('全候補が参照済みなら delete を発行しない（空リスト全削除の回避）', async () => {
    const { calls } = setupDb({
      candidates: [{ id: 'ev-1' }],
      referencedByPlans: [{ external_calendar_event_id: 'ev-1' }],
    });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'connection' },
    });

    expect(deleteCall(calls)).toBeUndefined();
  });

  // regression（#1988）: select / 参照読み取りの失敗を静かに飲み込むと、呼び出し元
  // （disconnect）は掃除が成功したと誤解して connection を消してしまう。fail-closed で throw する。
  it('select 失敗では throw して中断する（呼び出し元に fail-closed を選ばせる）', async () => {
    const { calls } = setupDb({ selectError: { code: '42501' } });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: { kind: 'connection' },
      }),
    ).rejects.toMatchObject({ code: '42501' });

    expect(deleteCall(calls)).toBeUndefined();
    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();
  });

  it('参照読み取りの失敗も throw して中断する', async () => {
    const { calls } = setupDb({
      candidates: [{ id: 'ev-1' }],
      referencedError: { code: '57014' },
    });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: { kind: 'connection' },
      }),
    ).rejects.toMatchObject({ code: '57014' });

    expect(deleteCall(calls)).toBeUndefined();
    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();
  });

  // regression（risk-reviewer 指摘）: 23503（select と delete の間の参照レース）以外の delete
  // 失敗を warn だけで飲み込むと、disconnect の fail-closed が効かず連鎖する未参照行を
  // 永久に見失う。23503 以外は throw する。
  it('23503 以外の delete 失敗は throw する', async () => {
    setupDb({
      candidates: [{ id: 'ev-1' }],
      deleteError: { code: '42501' },
    });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: { kind: 'connection' },
      }),
    ).rejects.toMatchObject({ code: '42501' });

    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();
  });

  it('23503（参照レース）の delete 失敗は throw せず warn に留める', async () => {
    setupDb({
      candidates: [{ id: 'ev-1' }],
      deleteError: { code: '23503' },
    });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: { kind: 'connection' },
      }),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipped some rows due to a reference race'),
    );
  });
});

describe('deleteUnreferencedEvents — batch 上限', () => {
  // regression（risk-reviewer 指摘）: 上限到達を warn だけで return すると、disconnect の
  // fail-closed が効かず、上限を超えた残り行が connection 削除で永久に回収不能になる。
  // window / calendars scope は時間窓が有限なので、上限到達は異常のサインとして throw する。
  it('window scope は batch 上限に到達したら部分結果のまま return せず throw する', async () => {
    setupDb({ alwaysFullBatch: true });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: {
          kind: 'window',
          notBefore: '2026-01-01T00:00:00.000Z',
          notAfter: '2026-12-31T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow('calendar event pruning hit the batch limit');

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('stopped at the batch limit'),
      expect.any(Object),
    );
  });

  // regression（Codex 指摘、#2000）: window scope と同じ低い上限を connection scope
  // （disconnect の全削除）にも適用すると、参照済み行（歴史的アンカー）が大量に混ざる
  // 接続で再試行しても毎回同じ場所で止まり、二度と切断できなくなる。connection scope は
  // 高い上限を持ち、window scope の上限（40 batch）を超えても throw せず完走する。
  it('connection scope は window scope の上限を超えても throw せず完走する', async () => {
    // 41 batch 満杯（旧上限 40 を超える）の後に自然終了させる。
    setupDb({ fullBatchesThenStop: 41 });

    await expect(
      deleteUnreferencedEvents({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        scope: { kind: 'connection' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('deleteUnreferencedEvents — keyset ページング', () => {
  // regression（#1996）: id は UUID 列。空文字を .gt('id', '') に渡すと PostgREST が
  // invalid UUID で落ちる。初回バッチでは cursor 条件そのものを送らない。
  //
  // このテストは fake table が文字列比較で `.gt` を素通りさせる mock ベースなので、
  // 実際の UUID キャストエラーは再現できない（それを再現するのが calendar-event-pruning
  // integration test の役目）。ここは「初回に .gt('id', …) を呼んでいないこと」という
  // 配線の契約だけを固定する。
  it('初回バッチでは id の cursor 条件を送らない', async () => {
    const { calls } = setupDb({ candidates: [{ id: 'ev-1' }] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'connection' },
    });

    const select = candidateSelect(calls)!;
    expect(select.chain.some((e) => e.method === 'gt' && e.args[0] === 'id')).toBe(false);
  });
});

describe('deleteUnreferencedEvents — scope 別フィルタ', () => {
  it('window scope は end_at/start_at の or フィルタを付ける', async () => {
    const { calls } = setupDb({ candidates: [{ id: 'ev-1' }] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: {
        kind: 'window',
        notBefore: '2026-04-25T00:00:00.000Z',
        notAfter: '2026-10-22T00:00:00.000Z',
      },
    });

    const select = candidateSelect(calls)!;
    expect(argsOf(select, 'or')).toEqual([
      'end_at.lt.2026-04-25T00:00:00.000Z,start_at.gt.2026-10-22T00:00:00.000Z',
    ]);
    expect(
      select.chain.some((e) => e.method === 'in' && e.args[0] === 'provider_calendar_id'),
    ).toBe(false);
  });

  it('calendars scope は provider_calendar_id の in フィルタを付ける', async () => {
    const { calls } = setupDb({ candidates: [{ id: 'ev-1' }] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'calendars', providerCalendarIds: ['cal-a', 'cal-b'] },
    });

    const select = candidateSelect(calls)!;
    const inCall = select.chain.find(
      (e) => e.method === 'in' && e.args[0] === 'provider_calendar_id',
    );
    expect(inCall?.args[1]).toEqual(['cal-a', 'cal-b']);
    expect(select.chain.some((e) => e.method === 'or')).toBe(false);
  });

  it('calendars scope が空なら DB に一切触れない（空 in を撃たない）', async () => {
    const { from } = setupDb({ candidates: [{ id: 'ev-1' }] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'calendars', providerCalendarIds: [] },
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('connection scope は or も provider_calendar_id in も付けない', async () => {
    const { calls } = setupDb({ candidates: [{ id: 'ev-1' }] });

    await deleteUnreferencedEvents({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      scope: { kind: 'connection' },
    });

    const select = candidateSelect(calls)!;
    expect(select.chain.some((e) => e.method === 'or')).toBe(false);
    expect(
      select.chain.some((e) => e.method === 'in' && e.args[0] === 'provider_calendar_id'),
    ).toBe(false);
    // ただし user_id / connection_id スコープは必ず付く
    const eqCols = select.chain.filter((e) => e.method === 'eq').map((e) => e.args[0]);
    expect(eqCols).toContain('user_id');
    expect(eqCols).toContain('connection_id');
  });
});
