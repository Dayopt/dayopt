import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarProviderError } from './providers/types';

/**
 * sync-service のテスト。
 *
 * overview.md §13 が必須と定める regression test 2 件（dismissed 不可侵 / prune anti-join）を
 * 含む。Supabase client は table + operation ごとに返り値を差し替えられる専用 mock で組む。
 */

const startSession = vi.hoisted(() => vi.fn());
const syncCalendar = vi.hoisted(() => vi.fn());
const decryptToken = vi.hoisted(() => vi.fn());
const persistCalendarTokenRotation = vi.hoisted(() => vi.fn());
const markCalendarConnectionReauth = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn((error: unknown) => error));
const getConfiguredExternalLifecycleAppVersion = vi.hoisted(() => vi.fn());
const isConfiguredFencedCalendarSyncWriterReady = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-key',
    CALENDAR_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError, captureUnexpectedDatabaseError }));
vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/database/external-lifecycle-version', () => ({
  getConfiguredExternalLifecycleAppVersion,
  isConfiguredFencedCalendarSyncWriterReady,
}));
vi.mock('./token-crypto', () => ({ decryptToken }));
vi.mock('./token-rotation', () => ({
  persistCalendarTokenRotation,
  markCalendarConnectionReauth,
}));
vi.mock('./providers/google', () => ({
  googleCalendarAdapter: { provider: 'google', startSession, syncCalendar },
}));

const beginCalendarSyncRun = vi.hoisted(() => vi.fn());
const clearCalendarSyncCursor = vi.hoisted(() => vi.fn());
const finishCalendarSyncRun = vi.hoisted(() => vi.fn());
const persistCalendarSyncResult = vi.hoisted(() => vi.fn());
const resolveProjectKey = vi.hoisted(() => vi.fn());

vi.mock('./fenced-sync-writer', () => ({
  beginCalendarSyncRun,
  clearCalendarSyncCursor,
  finishCalendarSyncRun,
  persistCalendarSyncResult,
  resolveProjectKey,
}));

import { PERSIST_RESERVE_MS, syncConnection } from './sync-service';

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const CALENDAR_ID = 'primary';
const RUN_ISO = '2026-07-24T00:00:00.000Z';
const UPSERT_ON_CONFLICT = 'user_id,provider,connection_id,provider_calendar_id,provider_event_id';

type QueryResult = { data: unknown; error: unknown };

type Recorder = { table: string; chain: Array<{ method: string; args: unknown[] }> };

type DbConfig = {
  connection?: Record<string, unknown> | null;
  connectionError?: unknown;
  calendars?: Array<Record<string, unknown>>;
  calendarsError?: unknown;
  pruneCandidates?: Array<{ id: string }>;
  pruneSelectError?: unknown;
  referencedByPlans?: Array<{ external_calendar_event_id: string | null }>;
  referencedByRecords?: Array<{ external_calendar_event_id: string | null }>;
  upsertError?: unknown;
  deleteError?: unknown;
};

function setupDb(config: DbConfig) {
  const calls: Recorder[] = [];
  const counters = { pruneSelect: 0 };

  function resolve(recorder: Recorder): QueryResult {
    const { table } = recorder;
    const methods = recorder.chain.map((entry) => entry.method);

    if (table === 'calendar_connections') {
      if (methods.includes('maybeSingle')) {
        return { data: config.connection ?? null, error: config.connectionError ?? null };
      }
      return { data: null, error: null };
    }
    if (table === 'calendar_connection_calendars') {
      if (methods.includes('update')) return { data: null, error: null };
      return { data: config.calendars ?? [], error: config.calendarsError ?? null };
    }
    if (table === 'external_calendar_events') {
      if (methods.includes('upsert')) return { data: null, error: config.upsertError ?? null };
      if (methods.includes('delete')) return { data: null, error: config.deleteError ?? null };
      if (methods.includes('update')) return { data: null, error: null };
      // prune candidate select. keyset ページングを 1 バッチで終わらせる。
      const batch = counters.pruneSelect;
      counters.pruneSelect += 1;
      if (batch === 0 && config.pruneSelectError) {
        return { data: null, error: config.pruneSelectError };
      }
      return { data: batch === 0 ? (config.pruneCandidates ?? []) : [], error: null };
    }
    if (table === 'plans') return { data: config.referencedByPlans ?? [], error: null };
    if (table === 'records') return { data: config.referencedByRecords ?? [], error: null };
    return { data: [], error: null };
  }

  const from = vi.fn((table: string) => {
    const recorder: Recorder = { table, chain: [] };
    calls.push(recorder);

    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (
              onFulfilled: (value: QueryResult) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => Promise.resolve(resolve(recorder)).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            recorder.chain.push({ method: prop, args });
            if (prop === 'maybeSingle' || prop === 'single') {
              return Promise.resolve(resolve(recorder));
            }
            return proxy;
          };
        },
      },
    );

    return proxy;
  });

  createClient.mockReturnValue({ from });
  return { calls };
}

function recordersFor(calls: Recorder[], table: string): Recorder[] {
  return calls.filter((recorder) => recorder.table === table);
}

function findCall(calls: Recorder[], table: string, method: string): Recorder | undefined {
  return recordersFor(calls, table).find((recorder) =>
    recorder.chain.some((entry) => entry.method === method),
  );
}

function argsOf(recorder: Recorder, method: string): unknown[] {
  const entry = recorder.chain.find((item) => item.method === method);
  if (!entry) throw new Error(`method ${method} was not called`);
  return entry.args;
}

function session() {
  return { accessToken: 'access-token', rotatedRefreshToken: null };
}

function syncResult(overrides: Record<string, unknown> = {}) {
  return {
    events: [],
    cancelledEventIds: [],
    skippedEventIds: [],
    nextCursor: 'next-sync-token',
    cursorInvalid: false,
    usedFullSync: false,
    deadlineExceeded: false,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: 'ev-1',
    title: 'Standup',
    description: 'daily',
    startAt: '2026-07-24T09:00:00.000Z',
    endAt: '2026-07-24T09:30:00.000Z',
    ...overrides,
  };
}

function activeConnection() {
  return {
    data_generation: 3,
    id: CONNECTION_ID,
    user_id: USER_ID,
    status: 'active',
    refresh_token_enc: 'enc',
  };
}

function oneCalendar(syncToken: string | null = 'existing-token') {
  return [
    {
      id: 'cal-row-1',
      provider_calendar_id: CALENDAR_ID,
      calendar_name: 'Work',
      sync_token: syncToken,
    },
  ];
}

function beginStarted(overrides: Record<string, unknown> = {}) {
  return {
    result: 'started',
    dataGeneration: 3,
    authorityFenceId: 'fence-1',
    authorityEpoch: 7,
    syncSequence: 42,
    runStartedAt: RUN_ISO,
    refreshTokenEnc: 'enc',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(RUN_ISO));
  decryptToken.mockReturnValue('refresh-token');
  persistCalendarTokenRotation.mockResolvedValue({
    outcome: 'updated',
    markReauthIfCurrent: null,
  });
  markCalendarConnectionReauth.mockResolvedValue('marked');
  getConfiguredExternalLifecycleAppVersion.mockResolvedValue(1);
  isConfiguredFencedCalendarSyncWriterReady.mockResolvedValue(false);
  startSession.mockResolvedValue(session());
  resolveProjectKey.mockReturnValue('project-key');
  beginCalendarSyncRun.mockResolvedValue(beginStarted());
  clearCalendarSyncCursor.mockResolvedValue('cleared');
  persistCalendarSyncResult.mockResolvedValue('persisted');
  finishCalendarSyncRun.mockResolvedValue('finished');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncConnection — active イベントの upsert', () => {
  it.each([false, true])('fenced=%s でも同期開始時刻の±90日を provider に渡す', async (fenced) => {
    isConfiguredFencedCalendarSyncWriterReady.mockResolvedValue(fenced);
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult());

    await expect(
      syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ).resolves.toMatchObject({ outcome: 'synced' });
    expect(syncCalendar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        window: { timeMin: '2026-04-25T00:00:00.000Z', timeMax: '2026-10-22T00:00:00.000Z' },
      }),
    );
  });

  it('旧DBでは追加前のconnection列だけを読み同期する', async () => {
    getConfiguredExternalLifecycleAppVersion.mockResolvedValue(0);
    const { calls } = setupDb({
      connection: {
        id: CONNECTION_ID,
        user_id: USER_ID,
        status: 'active',
        refresh_token_enc: 'enc',
      },
      calendars: oneCalendar(),
    });
    syncCalendar.mockResolvedValue(syncResult());

    await expect(syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID })).resolves.toEqual(
      {
        outcome: 'synced',
        calendarsSynced: 1,
        calendarsFailed: 0,
      },
    );

    const connection = findCall(calls, 'calendar_connections', 'maybeSingle');
    if (connection === undefined) throw new Error('connection query not found');
    expect(argsOf(connection, 'select')).toEqual(['id, user_id, status, refresh_token_enc']);
  });

  // regression（overview.md §13）: 再同期で dismissed を復活させない
  it('upsert payload に dismissed_at を含めず、全行のキー集合が一致する', async () => {
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: oneCalendar(),
    });
    syncCalendar.mockResolvedValue(
      syncResult({
        events: [
          event({ providerEventId: 'ev-1' }),
          event({ providerEventId: 'ev-2', description: null }),
        ],
      }),
    );

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    const upsert = findCall(calls, 'external_calendar_events', 'upsert');
    expect(upsert).toBeDefined();
    const [rows, options] = argsOf(upsert!, 'upsert') as [
      Array<Record<string, unknown>>,
      { onConflict: string },
    ];

    expect(options.onConflict).toBe(UPSERT_ON_CONFLICT);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'dismissed_at')).toBe(false);
    }
    // 全行のキー集合が同一でないと、PostgREST の和集合 columns で欠けた行の既存値が NULL 化される
    const keySets = rows.map((row) => Object.keys(row).sort().join(','));
    expect(new Set(keySets).size).toBe(1);
    // last_synced_at は run 開始時刻の単一値
    for (const row of rows) expect(row.last_synced_at).toBe(RUN_ISO);
  });

  it('connection_id と user_id を全行に載せる（複合 FK）', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    const upsert = findCall(calls, 'external_calendar_events', 'upsert')!;
    const [rows] = argsOf(upsert, 'upsert') as [Array<Record<string, unknown>>];
    expect(rows[0]).toMatchObject({
      connection_id: CONNECTION_ID,
      user_id: USER_ID,
      provider: 'google',
    });
  });
});

describe('syncConnection — prune 委譲', () => {
  // anti-join の詳細な regression は event-pruning.test.ts が正本。ここでは sync が
  // window scope で prune を呼び出す配線だけを確認する（未参照行が消えること）。
  it('window 境界の candidate select を発行し、未参照行を delete する', async () => {
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: oneCalendar(),
      pruneCandidates: [{ id: 'ev-1' }, { id: 'ev-2' }],
      referencedByPlans: [{ external_calendar_event_id: 'ev-1' }],
    });
    syncCalendar.mockResolvedValue(syncResult());

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    // event-pruning の window scope は end_at/start_at の or フィルタで候補を引く
    const candidateSelect = recordersFor(calls, 'external_calendar_events').find((recorder) =>
      recorder.chain.some((entry) => entry.method === 'or'),
    );
    expect(candidateSelect).toBeDefined();

    const del = findCall(calls, 'external_calendar_events', 'delete');
    expect(del).toBeDefined();
    expect(argsOf(del!, 'in')[1]).toEqual(['ev-2']);
  });

  // regression（#1988）: event-pruning.ts は select 失敗を throw するようになった
  // （event-pruning.test.ts 参照）。sync 経路はこれを best-effort として吸収し、window prune
  // の失敗だけで sync 全体を失敗扱いにしない。
  it('window prune が失敗しても sync 自体は synced のまま完了する', async () => {
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: oneCalendar(),
      pruneSelectError: { code: '42501' },
    });
    syncCalendar.mockResolvedValue(syncResult());

    await expect(
      syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ).resolves.toMatchObject({ outcome: 'synced' });

    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ operation: 'sync_window_prune' }),
    );
    expect(findCall(calls, 'external_calendar_events', 'delete')).toBeUndefined();
  });
});

describe('syncConnection — tombstone', () => {
  it('cancelled / skipped id は UPDATE で cancelled 化し、upsert しない', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(
      syncResult({ cancelledEventIds: ['c1'], skippedEventIds: ['s1'] }),
    );

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    // events が空なので upsert は発行されない（未知 id で行を作らない）
    expect(findCall(calls, 'external_calendar_events', 'upsert')).toBeUndefined();

    const tombstone = recordersFor(calls, 'external_calendar_events').find((recorder) =>
      recorder.chain.some(
        (entry) => entry.method === 'in' && entry.args[0] === 'provider_event_id',
      ),
    );
    expect(tombstone).toBeDefined();
    const inArgs = argsOf(tombstone!, 'in');
    expect(inArgs[1]).toEqual(['c1', 's1']);
    const updateArgs = argsOf(tombstone!, 'update')[0] as Record<string, unknown>;
    expect(updateArgs).toMatchObject({ status: 'cancelled', last_synced_at: RUN_ISO });
  });
});

describe('syncConnection — 410 と sweep', () => {
  it('410 で sync_token を NULL 化し、同 run 内で full sync し直し、sweep する', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar('stale') });
    syncCalendar
      .mockResolvedValueOnce(syncResult({ cursorInvalid: true, usedFullSync: false }))
      .mockResolvedValueOnce(
        syncResult({ events: [event()], usedFullSync: true, nextCursor: 'fresh-token' }),
      );

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    // 2 回目は cursor null（full sync）
    expect(syncCalendar).toHaveBeenCalledTimes(2);
    expect(syncCalendar.mock.calls[1]?.[1]).toMatchObject({ cursor: null });

    // sync_token を一度 NULL 化している
    const clearedToken = recordersFor(calls, 'calendar_connection_calendars').some((recorder) =>
      recorder.chain.some(
        (entry) =>
          entry.method === 'update' &&
          (entry.args[0] as Record<string, unknown>).sync_token === null,
      ),
    );
    expect(clearedToken).toBe(true);

    // full sync 完走なので sweep（lt + neq）が走る
    const sweep = recordersFor(calls, 'external_calendar_events').find((recorder) =>
      recorder.chain.some((entry) => entry.method === 'lt'),
    );
    expect(sweep).toBeDefined();
    expect(sweep!.chain.some((entry) => entry.method === 'neq')).toBe(true);
    const sweepLt = argsOf(sweep!, 'lt');
    expect(sweepLt).toEqual(['last_synced_at', RUN_ISO]);
  });

  it('full sync が途中で打ち切られた（nextCursor=null）ら sweep も token 保存もしない', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar(null) });
    syncCalendar.mockResolvedValue(
      syncResult({ events: [event()], usedFullSync: true, nextCursor: null }),
    );

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    // upsert は走る
    expect(findCall(calls, 'external_calendar_events', 'upsert')).toBeDefined();
    // sweep は走らない
    const sweep = recordersFor(calls, 'external_calendar_events').find((recorder) =>
      recorder.chain.some((entry) => entry.method === 'lt'),
    );
    expect(sweep).toBeUndefined();
    // sync_token 保存も走らない
    const savedToken = recordersFor(calls, 'calendar_connection_calendars').some((recorder) =>
      recorder.chain.some(
        (entry) =>
          entry.method === 'update' &&
          typeof (entry.args[0] as Record<string, unknown>).sync_token === 'string',
      ),
    );
    expect(savedToken).toBe(false);
  });

  it('全ページ完走時のみ sync_token を保存する', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar('old') });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()], nextCursor: 'brand-new' }));

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    const saved = recordersFor(calls, 'calendar_connection_calendars').find((recorder) =>
      recorder.chain.some(
        (entry) =>
          entry.method === 'update' &&
          (entry.args[0] as Record<string, unknown>).sync_token === 'brand-new',
      ),
    );
    expect(saved).toBeDefined();
  });
});

describe('syncConnection — forceFullSync', () => {
  it('sync_token があっても cursor null で呼ぶ', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar('has-token') });
    syncCalendar.mockResolvedValue(syncResult({ usedFullSync: true, nextCursor: 'tok' }));

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID, forceFullSync: true });

    expect(syncCalendar.mock.calls[0]?.[1]).toMatchObject({ cursor: null });
  });
});

describe('syncConnection — 認可と鍵', () => {
  it('refresh の invalid_grant で観測authorityを reauth_required にする', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    startSession.mockRejectedValue(
      new CalendarProviderError('revoked', 'reauth_required', 'invalid_grant', 400),
    );

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('reauth_required');
    expect(markCalendarConnectionReauth).toHaveBeenCalledWith({
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      expectedGeneration: 3,
      expectedRefreshTokenEnc: 'enc',
      lastSyncedAt: RUN_ISO,
    });
    // カレンダー同期は始めない
    expect(syncCalendar).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'not_configured'],
    ['superseded', 'partial_failure'],
  ] as const)(
    'invalid_grantのreauth結果が%sなら%sへ写像する',
    async (reauthOutcome, expectedOutcome) => {
      setupDb({ connection: activeConnection(), calendars: oneCalendar() });
      startSession.mockRejectedValue(
        new CalendarProviderError('revoked', 'reauth_required', 'invalid_grant', 400),
      );
      markCalendarConnectionReauth.mockResolvedValue(reauthOutcome);

      const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

      expect(result.outcome).toBe(expectedOutcome);
      expect(syncCalendar).not.toHaveBeenCalled();
    },
  );

  it('invalid_grantのreauth結果が不明ならthrowしてretryへ委ねる', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    startSession.mockRejectedValue(
      new CalendarProviderError('revoked', 'reauth_required', 'invalid_grant', 400),
    );
    markCalendarConnectionReauth.mockResolvedValue('unresolved');

    await expect(
      syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'SYNC_FAILED' });
    expect(syncCalendar).not.toHaveBeenCalled();
  });

  it('復号失敗は status を変えず encryption_key_invalid を記録する', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    decryptToken.mockImplementation(() => {
      throw new Error('bad key');
    });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('encryption_key_invalid');
    const update = findCall(calls, 'calendar_connections', 'update')!;
    const patch = argsOf(update, 'update')[0] as Record<string, unknown>;
    expect(patch.last_sync_error).toBe('encryption_key_invalid');
    // 鍵の設定ミスで全ユーザーを再同意に追い込まない
    expect(patch.status).toBeUndefined();
  });

  // 空配列に畳むと「0 件を同期して成功」になり、last_synced_at だけが進む（Step 7）
  it('選択カレンダーを読めなかったら成功として記録しない', async () => {
    const { calls } = setupDb({
      connection: activeConnection(),
      calendarsError: { code: '57014', message: 'canceling statement' },
    });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_failure');
    expect(syncCalendar).not.toHaveBeenCalled();
    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();

    const update = findCall(calls, 'calendar_connections', 'update')!;
    const patch = argsOf(update, 'update')[0] as Record<string, unknown>;
    expect(patch.last_sync_error).toBe('partial_failure');
    // last_synced_at は「最後に試した時刻」。他の失敗経路（鍵不正 / startSession 失敗）と
    // 揃える。進めないと dispatcher の due 判定（last_synced_at < staleBefore）に毎 tick
    // 引っかかり、この接続だけが backoff 無しで回り続ける。
    expect(patch.last_synced_at).toBe(RUN_ISO);
  });

  it('選択カレンダーが 0 件なら成功として記録する', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: [] });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('synced');
    const update = findCall(calls, 'calendar_connections', 'update')!;
    const patch = argsOf(update, 'update')[0] as Record<string, unknown>;
    expect(patch.last_sync_error).toBeNull();
  });
});

describe('syncConnection — 予算切れ（#1965）', () => {
  it('deadlineAt から PERSIST_RESERVE_MS を引いた値を adapter.syncCalendar へ渡す', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult());
    const deadlineAt = Date.now() + 30_000;

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID, deadlineAt });

    // 素の deadlineAt をそのまま渡すと、判定直後に取得したページの永続化（upsert /
    // tombstone / token 保存）自体が予算を考慮しない（risk-reviewer 指摘、PR #2075）。
    expect(syncCalendar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deadlineAt: deadlineAt - PERSIST_RESERVE_MS }),
    );
  });

  it('カレンダーが予算切れで打ち切られ、他に完走が無ければ last_synced_at を進めない', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ deadlineExceeded: true, nextCursor: null }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_timeout');
    expect(result.calendarsSynced).toBe(0);
    expect(result.calendarsFailed).toBe(0);
    // 完全な空振り run（calendarsSynced === 0）。last_synced_at を進めると due 判定
    // （昇順）でこの接続が列の最後尾へ回り、starvation 防止の順序が無効化されるため、
    // 何も書き込まない（risk-reviewer 指摘、PR #2075）。
    expect(findCall(calls, 'calendar_connections', 'update')).toBeUndefined();
  });

  it('部分的に進捗があった予算切れは last_sync_error を書いて last_synced_at を進める', async () => {
    const CALENDAR_B = 'secondary';
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: [
        { provider_calendar_id: CALENDAR_ID, calendar_name: 'Work', sync_token: null },
        { provider_calendar_id: CALENDAR_B, calendar_name: 'Personal', sync_token: null },
      ],
    });
    syncCalendar
      .mockResolvedValueOnce(syncResult({ nextCursor: 'completed-token' }))
      .mockResolvedValueOnce(syncResult({ deadlineExceeded: true, nextCursor: null }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_timeout');
    const update = findCall(calls, 'calendar_connections', 'update')!;
    const patch = argsOf(update, 'update')[0] as Record<string, unknown>;
    // partial_failure（実際の失敗）とは別コードにする。次回 sync で前進する見込みがあり、
    // リトライ導線の文言が異なる。
    expect(patch.last_sync_error).toBe('partial_timeout');
    expect(patch.last_synced_at).toBe(RUN_ISO);
  });

  it('予算切れ前に完走したカレンダーの進捗（sync_token）は保存される', async () => {
    const CALENDAR_B = 'secondary';
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: [
        { provider_calendar_id: CALENDAR_ID, calendar_name: 'Work', sync_token: null },
        { provider_calendar_id: CALENDAR_B, calendar_name: 'Personal', sync_token: null },
      ],
    });
    syncCalendar
      .mockResolvedValueOnce(syncResult({ nextCursor: 'completed-token' }))
      .mockResolvedValueOnce(syncResult({ deadlineExceeded: true, nextCursor: null }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_timeout');
    expect(result.calendarsSynced).toBe(1);
    const tokenUpdates = recordersFor(calls, 'calendar_connection_calendars').filter((recorder) =>
      recorder.chain.some((entry) => entry.method === 'update'),
    );
    // 完走した 1 カレンダー分だけ sync_token が確定する。打ち切られた方は更新されない
    // （cursor を確定しない契約は #1965 でも変わらない）。
    expect(tokenUpdates).toHaveLength(1);
    expect(argsOf(tokenUpdates[0]!, 'update')[0]).toMatchObject({ sync_token: 'completed-token' });
  });

  // 実際の失敗（provider / DB エラー）と予算切れが同一 run で起きた場合、前者を優先報告
  // する（risk-reviewer 指摘、PR #2075）。partial_timeout が先に返ると「選択を確認して」
  // という実失敗側の行動喚起が「もう一度お試しください」に隠れてしまう。
  it('calendarsFailed と calendarsIncomplete が同一 run で両方起きたら partial_failure を優先する', async () => {
    const CALENDAR_B = 'secondary';
    const { calls } = setupDb({
      connection: activeConnection(),
      calendars: [
        { provider_calendar_id: CALENDAR_ID, calendar_name: 'Work', sync_token: null },
        { provider_calendar_id: CALENDAR_B, calendar_name: 'Personal', sync_token: null },
      ],
    });
    syncCalendar
      .mockRejectedValueOnce(new CalendarProviderError('shared removed', 'forbidden'))
      .mockResolvedValueOnce(syncResult({ deadlineExceeded: true, nextCursor: null }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_failure');
    const update = findCall(calls, 'calendar_connections', 'update')!;
    const patch = argsOf(update, 'update')[0] as Record<string, unknown>;
    expect(patch.last_sync_error).toBe('partial_failure');
  });

  // reauth_required と deadline_exceeded が同一 run で両方起きた場合、reauth を優先する
  // （behavior-verifier 指摘、#1965）。データは失われない — 予算切れ側の進捗は
  // syncOneCalendar 内で既に永続化済み（ループ後の分岐より前）で、単に outcome/last_sync_error
  // として表に出るのが 'reauth_required' 側になるだけ。ユーザーはどのみち再接続が要る。
  it('同一 run で reauth_required と deadline_exceeded が両方起きたら reauth_required を優先する', async () => {
    const CALENDAR_B = 'secondary';
    setupDb({
      connection: activeConnection(),
      calendars: [
        { provider_calendar_id: CALENDAR_ID, calendar_name: 'Work', sync_token: null },
        { provider_calendar_id: CALENDAR_B, calendar_name: 'Personal', sync_token: null },
      ],
    });
    syncCalendar
      .mockRejectedValueOnce(
        new CalendarProviderError('revoked', 'reauth_required', 'invalid_grant', 401),
      )
      .mockResolvedValueOnce(syncResult({ deadlineExceeded: true, nextCursor: null }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('reauth_required');
    expect(markCalendarConnectionReauth).toHaveBeenCalled();
  });
});

describe('syncConnection — 認可の再確認', () => {
  it('reauth_required の接続は skip する', async () => {
    setupDb({
      connection: { ...activeConnection(), status: 'reauth_required' },
      calendars: oneCalendar(),
    });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('skipped_reauth_required');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('接続が存在しなければ not_configured', async () => {
    setupDb({ connection: null });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('not_configured');
  });

  it('connection をロードできない DB 障害は throw する', async () => {
    setupDb({ connectionError: { code: '08006', message: 'connection refused' } });

    await expect(
      syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ).rejects.toMatchObject({
      code: 'SYNC_FAILED',
    });
  });
});

describe('syncConnection — token rotation', () => {
  it('rotation された refresh token をgeneration-bound RPCで保存する', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    startSession.mockResolvedValue({ accessToken: 'a', rotatedRefreshToken: 'rotated' });
    syncCalendar.mockResolvedValue(syncResult());

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(persistCalendarTokenRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        expectedGeneration: 3,
        expectedRefreshTokenEnc: 'enc',
        rotatedRefreshToken: 'rotated',
        provider: expect.any(Object),
        lastSyncedAt: RUN_ISO,
      }),
    );
    expect(syncCalendar).toHaveBeenCalled();
  });

  it('rotation更新後の同run 401を同じ新authorityの証明で再認証へ収束する', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    const markRotatedAuthority = vi.fn().mockResolvedValue('marked');
    startSession.mockResolvedValue({ accessToken: 'a', rotatedRefreshToken: 'rotated' });
    persistCalendarTokenRotation.mockResolvedValue({
      outcome: 'updated',
      markReauthIfCurrent: markRotatedAuthority,
    });
    syncCalendar.mockRejectedValue(
      new CalendarProviderError('revoked', 'reauth_required', 'invalid_grant', 401),
    );

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result).toEqual({
      outcome: 'reauth_required',
      calendarsSynced: 0,
      calendarsFailed: 0,
    });
    expect(markRotatedAuthority).toHaveBeenCalledTimes(1);
    expect(markCalendarConnectionReauth).not.toHaveBeenCalled();
  });

  it('purgeが先行してtokenをoutboxへ退避したら後続同期を止める', async () => {
    const { calls } = setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    startSession.mockResolvedValue({ accessToken: 'a', rotatedRefreshToken: 'rotated' });
    persistCalendarTokenRotation.mockResolvedValue({
      outcome: 'enqueued',
      markReauthIfCurrent: null,
    });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result).toEqual({
      outcome: 'not_configured',
      calendarsSynced: 0,
      calendarsFailed: 0,
    });
    expect(syncCalendar).not.toHaveBeenCalled();
    expect(recordersFor(calls, 'calendar_connection_calendars')).toHaveLength(0);
    expect(recordersFor(calls, 'external_calendar_events')).toHaveLength(0);
    const statusWrite = recordersFor(calls, 'calendar_connections').find((recorder) =>
      recorder.chain.some((entry) => entry.method === 'update'),
    );
    expect(statusWrite).toBeUndefined();
  });

  it.each([
    ['reauth_required', 'reauth_required'],
    ['missing', 'not_configured'],
    ['superseded', 'partial_failure'],
  ] as const)(
    'token rotation結果が%sなら%sで後続同期を止める',
    async (outcome, expectedOutcome) => {
      setupDb({
        connection: activeConnection(),
        calendars: oneCalendar(),
      });
      startSession.mockResolvedValue({ accessToken: 'a', rotatedRefreshToken: 'rotated' });
      persistCalendarTokenRotation.mockResolvedValue({
        outcome,
        markReauthIfCurrent: null,
      });

      const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

      expect(result.outcome).toBe(expectedOutcome);
      expect(syncCalendar).not.toHaveBeenCalled();
    },
  );

  it('token rotation結果を確定できなければ後続同期を止めてthrowする', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    startSession.mockResolvedValue({ accessToken: 'a', rotatedRefreshToken: 'rotated' });
    persistCalendarTokenRotation.mockResolvedValue({
      outcome: 'unresolved',
      markReauthIfCurrent: null,
    });

    await expect(
      syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'SYNC_FAILED' });
    expect(syncCalendar).not.toHaveBeenCalled();
  });
});

describe('syncConnection — 情報漏洩', () => {
  it('refresh token をログに出さない', async () => {
    setupDb({ connection: activeConnection(), calendars: oneCalendar() });
    decryptToken.mockReturnValue('1//super-secret-refresh');
    startSession.mockRejectedValue(new CalendarProviderError('boom', 'transient'));
    syncCalendar.mockResolvedValue(syncResult());

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('super-secret-refresh');
  });
});

// =============================================================================
// #2050: lifecycleVersion >= 2（fenced sync writer 経路）
//
// v0/v1（上記）とは独立した経路。CAS 入出力とチャンク化・superseded の扱いに絞って
// 検証する（RPC 呼び出しの discriminant マッピングは overview.md §3 が正本）。
// =============================================================================

describe('syncConnection — fenced writer ready', () => {
  beforeEach(() => {
    isConfiguredFencedCalendarSyncWriterReady.mockResolvedValue(true);
  });

  it('begin が missing なら not_configured を返す（RPC を一切呼ばない）', async () => {
    beginCalendarSyncRun.mockResolvedValue({ result: 'missing' });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result).toEqual({ outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('begin が reauth_required なら skipped_reauth_required を返す', async () => {
    beginCalendarSyncRun.mockResolvedValue({ result: 'reauth_required' });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('skipped_reauth_required');
  });

  // project fence / quarantine fence 由来の superseded は全ユーザーに影響しうるグローバル
  // 状態なので、無音の全停止を防ぐため必ず capture する（overview.md §3、critic 指摘）。
  it('begin が superseded なら captureUnexpectedError してから not_configured を返す', async () => {
    beginCalendarSyncRun.mockResolvedValue({ result: 'superseded' });

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('not_configured');
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'calendar_sync_fence_superseded' }),
    );
  });

  it('projectKey が解決できないなら not_configured を返し begin を呼ばない', async () => {
    resolveProjectKey.mockReturnValue(null);

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('not_configured');
    expect(beginCalendarSyncRun).not.toHaveBeenCalled();
  });

  it('成功時は finishCalendarSyncRun を begin の CAS state で呼び、synced を返す', async () => {
    setupDb({ calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result).toEqual({ outcome: 'synced', calendarsSynced: 1, calendarsFailed: 0 });
    expect(persistCalendarSyncResult).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        userId: USER_ID,
        projectKey: 'project-key',
        expectedGeneration: 3,
        expectedAuthorityFenceId: 'fence-1',
        expectedAuthorityEpoch: 7,
        expectedSyncSequence: 42,
        calendarSelectionId: 'cal-row-1',
        providerCalendarId: CALENDAR_ID,
        usedFullSync: false,
        nextCursor: 'next-sync-token',
      }),
    );
    expect(finishCalendarSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        expectedSyncSequence: 42,
        runStartedAt: RUN_ISO,
        lastSyncError: null,
      }),
    );
  });

  // RPC 側の 10,000 件上限（events/tombstone 別）と、events/tombstone 間の id 重複拒否
  // （migration:401-404, 460-464）に対応する chunk 化 + dedupe（overview.md §3）。
  it('2,000 件超の events を chunk 化し、重複 id を dedupe してから渡す', async () => {
    setupDb({ calendars: oneCalendar() });
    const events = [
      ...Array.from({ length: 2500 }, (_, i) =>
        event({ providerEventId: `ev-${i}`, title: `v1-${i}` }),
      ),
      // 重複 id（後勝ち）。dedupe 後は 2500 件のまま増えない。
      event({ providerEventId: 'ev-0', title: 'v2-0' }),
    ];
    syncCalendar.mockResolvedValue(
      syncResult({
        events,
        // ev-0 は events 側にも存在するため、tombstone からは除外されるはず。
        cancelledEventIds: ['ev-0', 'ev-cancelled-only'],
        usedFullSync: true,
      }),
    );

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(persistCalendarSyncResult).toHaveBeenCalledTimes(2);
    const [firstCallArgs] = persistCalendarSyncResult.mock.calls[0] as [
      {
        events: unknown[];
        tombstoneEventIds: string[];
        usedFullSync: boolean;
        nextCursor: unknown;
      },
    ];
    const [secondCallArgs] = persistCalendarSyncResult.mock.calls[1] as [
      {
        events: unknown[];
        tombstoneEventIds: string[];
        usedFullSync: boolean;
        nextCursor: unknown;
      },
    ];

    expect(firstCallArgs.events).toHaveLength(2000);
    expect(secondCallArgs.events).toHaveLength(500);
    // 後勝ち dedupe: ev-0 の title は v2-0 のみが残る。
    const allEvents = [...firstCallArgs.events, ...secondCallArgs.events] as Array<{
      providerEventId: string;
      title: string;
    }>;
    expect(allEvents.filter((e) => e.providerEventId === 'ev-0')).toHaveLength(1);
    expect(allEvents.find((e) => e.providerEventId === 'ev-0')?.title).toBe('v2-0');

    // 最終 chunk だけが tombstone / usedFullSync / nextCursor を運ぶ。
    expect(firstCallArgs.tombstoneEventIds).toEqual([]);
    expect(firstCallArgs.usedFullSync).toBe(false);
    expect(firstCallArgs.nextCursor).toBeNull();
    // ev-0 は events 側に存在するため tombstone から除外される。
    expect(secondCallArgs.tombstoneEventIds).toEqual(['ev-cancelled-only']);
    expect(secondCallArgs.usedFullSync).toBe(true);
  });

  // 良性競合（先行/後続 run に追い越された）は実失敗として報告しない
  // （overview.md §3、critic 指摘）。
  it('persist が superseded を返したら calendarsFailed を増やさず not_configured を返す', async () => {
    setupDb({ calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));
    persistCalendarSyncResult.mockResolvedValue('superseded');

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result).toEqual({ outcome: 'not_configured', calendarsSynced: 0, calendarsFailed: 0 });
    expect(finishCalendarSyncRun).not.toHaveBeenCalled();
  });

  // pr-cross-review P2（PR #2276）: begin/clear/persist/finish が deadlineAt を無視して
  // 固定 retry 予算を消費すると、1 接続が cron の maxDuration を食い潰し後続接続を
  // starve させる。deadline_exceeded は 'failed' ではなく既存の deadlineExceeded 経路
  // （calendarsIncomplete）に合流させる。
  it('persist が deadline_exceeded を返したら failed ではなく calendarsIncomplete に数える', async () => {
    setupDb({ calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));
    persistCalendarSyncResult.mockResolvedValue('deadline_exceeded');

    const result = await syncConnection({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      deadlineAt: Date.now() + 5_000,
    });

    // 空振り（1 カレンダーも完走しなかった）なので last_synced_at は進めない
    // （既存の calendarsIncomplete 分岐と同じ意味論）。
    expect(result).toEqual({ outcome: 'partial_timeout', calendarsSynced: 0, calendarsFailed: 0 });
  });

  it('deadlineAt が渡されると begin/persist/finish の呼び出し引数に伝播する', async () => {
    setupDb({ calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));
    const deadlineAt = Date.now() + 30_000;

    await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID, deadlineAt });

    expect(beginCalendarSyncRun).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt }));
    expect(persistCalendarSyncResult).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt }));
    expect(finishCalendarSyncRun).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt }));
  });

  it('missing_selection は実失敗として partial_failure を報告する', async () => {
    setupDb({ calendars: oneCalendar() });
    syncCalendar.mockResolvedValue(syncResult({ events: [event()] }));
    persistCalendarSyncResult.mockResolvedValue('missing_selection');

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('partial_failure');
    expect(finishCalendarSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncError: 'partial_failure' }),
    );
  });

  it('cursorInvalid（410）では clearCalendarSyncCursor を呼んでから full sync をやり直す', async () => {
    setupDb({ calendars: oneCalendar('stale-token') });
    syncCalendar
      .mockResolvedValueOnce(syncResult({ cursorInvalid: true }))
      .mockResolvedValueOnce(syncResult({ events: [event()] }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(clearCalendarSyncCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarSelectionId: 'cal-row-1',
        providerCalendarId: CALENDAR_ID,
        expectedSyncToken: 'stale-token',
      }),
    );
    expect(syncCalendar).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ cursor: null }),
    );
    expect(result.outcome).toBe('synced');
  });

  // clear cursor の response-loss retry は「既に clear 済み」を意味しうる。'failed' にせず
  // full sync として続行する（overview.md §3、critic 指摘）。
  it('clearCalendarSyncCursor が superseded を返しても失敗にせず full sync を続行する', async () => {
    setupDb({ calendars: oneCalendar('stale-token') });
    clearCalendarSyncCursor.mockResolvedValue('superseded');
    syncCalendar
      .mockResolvedValueOnce(syncResult({ cursorInvalid: true }))
      .mockResolvedValueOnce(syncResult({ events: [event()] }));

    const result = await syncConnection({ connectionId: CONNECTION_ID, userId: USER_ID });

    expect(result.outcome).toBe('synced');
  });
});
