import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createServiceRoleClient = vi.hoisted(() => vi.fn());
const syncConnection = vi.hoisted(() => vi.fn());
const isBillingEnforced = vi.hoisted(() => vi.fn(() => false));
const checkEntitlementForUser = vi.hoisted(() => vi.fn());
const isDailyFullSyncSlot = vi.hoisted(() => vi.fn((_connectionId: string, _now: Date) => false));
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn((error: unknown) => error));
const captureUnexpectedError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));
vi.mock('@/lib/billing/enforcement', () => ({ isBillingEnforced, checkEntitlementForUser }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedDatabaseError, captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sync-service', () => ({ syncConnection }));
vi.mock('./sync-schedule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync-schedule')>();
  return { ...actual, isDailyFullSyncSlot };
});

import { dispatchCalendarSync } from './sync-dispatcher';

const NOW = new Date('2026-07-24T03:07:00.000Z');
const FAR_DEADLINE = 10 ** 15; // Date.now() を超えない = 予算切れしない

type Recorder = { chain: Array<{ method: string; args: unknown[] }> };

/** calendar_connections の select チェーンを 1 つだけ持つ mock。 */
function setupDb(result: { data: unknown; error: unknown }) {
  const recorder: Recorder = { chain: [] };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (onF: (v: typeof result) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(onF, onR);
        }
        return (...args: unknown[]) => {
          recorder.chain.push({ method: prop, args });
          return proxy;
        };
      },
    },
  );
  const from = vi.fn(() => proxy);
  createServiceRoleClient.mockReturnValue({ from });
  return { recorder, from };
}

function connections(n: number) {
  return Array.from({ length: n }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    user_id: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    consecutive_failures: index,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  isBillingEnforced.mockReturnValue(false);
  isDailyFullSyncSlot.mockReturnValue(false);
  syncConnection.mockResolvedValue({ outcome: 'synced', calendarsSynced: 1, calendarsFailed: 0 });
  checkEntitlementForUser.mockResolvedValue('allowed');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchCalendarSync — due フィルタ', () => {
  it('active かつ stale の接続を last_synced_at 昇順で列挙する', async () => {
    const { recorder, from } = setupDb({ data: connections(2), error: null });

    await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    expect(from).toHaveBeenCalledWith('calendar_connections');
    const methods = Object.fromEntries(recorder.chain.map((e) => [e.method, e.args]));
    // status='active' で絞る
    expect(recorder.chain).toContainEqual({ method: 'eq', args: ['status', 'active'] });
    // last_synced_at is null or < cutoff
    const orArgs = recorder.chain.filter((e) => e.method === 'or').map((e) => String(e.args[0]));
    expect(orArgs).toHaveLength(2);
    expect(orArgs[0]).toBe('last_synced_at.is.null,last_synced_at.lt.2026-07-24T02:53:00.000Z');
    // 連続失敗が閾値未満、または前回の書き込みから 1 時間経った接続だけ（#2687）
    expect(orArgs[1]).toBe('consecutive_failures.lt.6,updated_at.lt.2026-07-24T02:07:00.000Z');
    // 昇順・NULL 最優先
    expect(methods.order).toEqual(['last_synced_at', { ascending: true, nullsFirst: true }]);
    // token 系を触らない列指定
    expect(String(methods.select?.[0])).toBe('id, user_id, consecutive_failures');
  });

  it('列挙エラーは throw する（route が 500 にできるよう）', async () => {
    setupDb({ data: null, error: { code: '08006' } });

    await expect(dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE })).rejects.toBeTruthy();
    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();
  });
});

describe('dispatchCalendarSync — 逐次同期', () => {
  it('due 接続ごとに syncConnection を user_id 付きで呼ぶ', async () => {
    setupDb({ data: connections(3), error: null });

    const summary = await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    expect(syncConnection).toHaveBeenCalledTimes(3);
    // deadlineAt は接続と接続の「間」だけでなく接続の内側にも渡す（#1965）。
    expect(syncConnection).toHaveBeenCalledWith({
      connectionId: connections(1)[0]!.id,
      userId: connections(1)[0]!.user_id,
      forceFullSync: false,
      deadlineAt: FAR_DEADLINE,
    });
    expect(summary).toMatchObject({
      due: 3,
      processed: 3,
      failed: 0,
      skippedNonPro: 0,
      deferred: 0,
    });
  });

  it('1接続の未確定失敗を隔離し、後続due接続を処理する', async () => {
    setupDb({ data: connections(3), error: null });
    syncConnection.mockRejectedValueOnce(new Error('provider-secret-detail'));

    const summary = await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    expect(syncConnection).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ due: 3, processed: 3, failed: 1, deferred: 0 });
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'calendar connection sync was isolated' }),
      expect.objectContaining({
        operation: 'dispatch_sync_connection',
        // どの接続が何回失敗しているかを内部 ID で追えるようにする（#2687）
        connectionId: '00000000-0000-4000-8000-000000000000',
        consecutiveFailures: 0,
      }),
    );
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain(
      'provider-secret-detail',
    );
  });

  it('full resync スロットに当たった接続だけ forceFullSync=true で呼ぶ', async () => {
    setupDb({ data: connections(2), error: null });
    isDailyFullSyncSlot.mockImplementation((connectionId: string) => connectionId.endsWith('001'));

    await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    const calls = syncConnection.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.connectionId.endsWith('000'))?.forceFullSync).toBe(false);
    expect(calls.find((c) => c.connectionId.endsWith('001'))?.forceFullSync).toBe(true);
  });
});

describe('dispatchCalendarSync — 時間予算', () => {
  it('deadline を過ぎたら残りを処理せず deferred に計上する', async () => {
    setupDb({ data: connections(3), error: null });
    // 1 件処理したら締切を過ぎるよう、syncConnection のたびに現在時刻を進める
    let calls = 0;
    const past = Date.now() - 1000;
    syncConnection.mockImplementation(async () => {
      calls += 1;
      return { outcome: 'synced', calendarsSynced: 0, calendarsFailed: 0 };
    });

    // deadlineAt を「1 件処理後には過ぎている」値にする: 最初のループ判定は通し、
    // 2 週目で Date.now() >= deadlineAt にするため過去値を使う。
    const summary = await dispatchCalendarSync({ now: NOW, deadlineAt: past });

    // 最初の判定で即中断（Date.now() > past）。1 件も処理しない。
    expect(calls).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.deferred).toBe(3);
  });
});

describe('dispatchCalendarSync — 課金ゲート', () => {
  it('BILLING_ENFORCED off なら pro チェックせず全件処理する', async () => {
    setupDb({ data: connections(2), error: null });
    isBillingEnforced.mockReturnValue(false);

    await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    expect(checkEntitlementForUser).not.toHaveBeenCalled();
    expect(syncConnection).toHaveBeenCalledTimes(2);
  });

  it('BILLING_ENFORCED on で非 Pro は skip する', async () => {
    setupDb({ data: connections(2), error: null });
    isBillingEnforced.mockReturnValue(true);
    checkEntitlementForUser.mockResolvedValueOnce('allowed').mockResolvedValueOnce('denied');

    const summary = await dispatchCalendarSync({ now: NOW, deadlineAt: FAR_DEADLINE });

    expect(syncConnection).toHaveBeenCalledTimes(1);
    expect(summary.skippedNonPro).toBe(1);
    expect(summary.processed).toBe(1);
    // capability map のどのキーで判定したかまで固定する（gate の切れ目が
    // external_calendar_sync 以外へずれたら落とす）。
    expect(checkEntitlementForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'external_calendar_sync',
    );
  });
});
