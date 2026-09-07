import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';

const captureUnexpectedError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  createSupabase,
  mirrorRow,
  reference,
  type MirrorRow,
} from '@/lib/test/external-calendar-ghost-fixture';

import { listGhostEvents } from './event-query-service';

const USER_ID = 'user-1';
const RANGE = { startAt: '2026-08-10T00:00:00.000Z', endAt: '2026-08-17T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listGhostEvents / 除外条件', () => {
  it('active な行だけを返す', async () => {
    const { supabase } = createSupabase({ events: [mirrorRow({ id: 'a' })] });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).resolves.toEqual([
      {
        id: 'a',
        title: 'Standup',
        calendarName: 'Work',
        startAt: '2026-08-11T09:00:00.000Z',
        endAt: '2026-08-11T09:30:00.000Z',
      },
    ]);
  });

  it.each([
    ['cancelled', { status: 'cancelled' }],
    ['未知の status（allowlist なので落ちる）', { status: 'tentative' }],
    ['dismissed 済み', { dismissed_at: '2026-08-11T00:00:00.000Z' }],
    ['connection が外れた孤児', { connection_id: null }],
    ['他ユーザーの行', { user_id: 'user-2' }],
    ['範囲より後', { start_at: '2026-08-20T09:00:00.000Z', end_at: '2026-08-20T10:00:00.000Z' }],
    ['範囲より前', { start_at: '2026-08-01T09:00:00.000Z', end_at: '2026-08-01T10:00:00.000Z' }],
    ['時刻が欠けている', { start_at: null, end_at: null }],
  ])('%s は返さない', async (_label, overrides) => {
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a', ...overrides })],
    });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).resolves.toEqual([]);
  });

  it('範囲の端に跨る予定は返す（半開区間）', async () => {
    const { supabase } = createSupabase({
      events: [
        mirrorRow({
          id: 'a',
          start_at: '2026-08-09T23:00:00.000Z',
          end_at: '2026-08-10T01:00:00.000Z',
        }),
      ],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['a']);
  });

  it('description を SELECT しない', async () => {
    const { supabase, eventTables } = createSupabase({ events: [mirrorRow({ id: 'a' })] });

    await listGhostEvents(supabase, USER_ID, RANGE);

    const selectArg = eventTables[0]?.select.mock.calls[0]?.[0] as string;
    expect(selectArg).not.toContain('description');
    expect(selectArg).not.toContain('*');
  });
});

describe('listGhostEvents / plans・records の anti-join', () => {
  it('plans が参照済みの行は返さない', async () => {
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a' }), mirrorRow({ id: 'b' })],
      plans: [reference('a')],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['b']);
  });

  it('records が参照済みの行は返さない', async () => {
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a' }), mirrorRow({ id: 'b' })],
      records: [reference('b')],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['a']);
  });

  it('soft-delete された plan が参照する行は ghost に戻る', async () => {
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
      plans: [reference('a', '2026-08-11T12:00:00.000Z')],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['a']);
  });

  it('参照の読み取りにも user_id を明示する', async () => {
    const { supabase, referenceTables } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
    });

    await listGhostEvents(supabase, USER_ID, RANGE);

    expect(referenceTables).toHaveLength(2);
    for (const table of referenceTables) {
      expect(table.eq).toHaveBeenCalledWith('user_id', USER_ID);
    }
  });
});

describe('listGhostEvents / ページング', () => {
  const BATCH_SIZE = 150;

  function manyRows(count: number, prefix = 'e'): MirrorRow[] {
    return Array.from({ length: count }, (_, index) =>
      mirrorRow({ id: `${prefix}-${String(index).padStart(4, '0')}` }),
    );
  }

  it('1 バッチに満たなければ 1 回で終わる', async () => {
    const { supabase, eventTables } = createSupabase({ events: manyRows(BATCH_SIZE - 1) });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);

    expect(events).toHaveLength(BATCH_SIZE - 1);
    expect(eventTables).toHaveLength(1);
  });

  it('バッチが埋まったら cursor を進めて続きを取る', async () => {
    const rows = manyRows(BATCH_SIZE + 10);
    const { supabase, eventTables } = createSupabase({ events: rows });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);

    expect(events).toHaveLength(BATCH_SIZE + 10);
    expect(eventTables).toHaveLength(2);

    const secondBatchCursor = eventTables[1]?.calls.find(
      ([name, column]) => name === 'gt' && column === 'id',
    );
    expect(secondBatchCursor?.[2]).toBe(rows[BATCH_SIZE - 1]?.id);
  });

  it('id 昇順で order してから limit する（順序無保証の取りこぼしを避ける）', async () => {
    const { supabase, eventTables } = createSupabase({ events: manyRows(3) });

    await listGhostEvents(supabase, USER_ID, RANGE);

    const names = eventTables[0]?.calls.map(([name]) => name) ?? [];
    expect(names.indexOf('order')).toBeLessThan(names.indexOf('limit'));
    expect(eventTables[0]?.order).toHaveBeenCalledWith('id', { ascending: true });
  });

  it('初回ページでは id の cursor 条件を送らない（空文字を UUID 列に渡すと invalid UUID になる）', async () => {
    const { supabase, eventTables } = createSupabase({ events: [mirrorRow({ id: 'a' })] });

    await listGhostEvents(supabase, USER_ID, RANGE);

    const idCursorCalls = eventTables[0]?.calls.filter(
      ([name, column]) => name === 'gt' && column === 'id',
    );
    expect(idCursorCalls).toEqual([]);
  });

  it('2 ページ目以降は前バッチ最後の id を cursor に使う', async () => {
    const rows = manyRows(BATCH_SIZE + 10);
    const { supabase, eventTables } = createSupabase({ events: rows });

    await listGhostEvents(supabase, USER_ID, RANGE);

    const firstBatchIdCursor = eventTables[0]?.calls.find(
      ([name, column]) => name === 'gt' && column === 'id',
    );
    expect(firstBatchIdCursor).toBeUndefined();

    const secondBatchCursor = eventTables[1]?.calls.find(
      ([name, column]) => name === 'gt' && column === 'id',
    );
    expect(secondBatchCursor?.[2]).toBe(rows[BATCH_SIZE - 1]?.id);
  });

  it('batch 上限に達したら部分結果を返さず例外を投げ、Sentry へ送る', async () => {
    const MAX_BATCHES = 20;
    const { supabase, eventTables } = createSupabase({
      events: manyRows(BATCH_SIZE * MAX_BATCHES + 1),
    });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });

    expect(eventTables).toHaveLength(MAX_BATCHES);
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'ghost_query_batch_limit' }),
    );
  });
});

describe('listGhostEvents / 選択解除済みカレンダーの historical anchor', () => {
  it('現在選択されていない (connection_id, provider_calendar_id) の行は返さない', async () => {
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a', provider_calendar_id: 'calendar-removed' })],
      selectedCalendars: [],
    });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).resolves.toEqual([]);
  });

  it('soft-delete 済み参照が anti-join を通しても、選択解除済みなら ghost に戻さない', async () => {
    // plans が soft-delete 済みだと anti-join は「未参照」扱いにする（既存挙動、上のテスト参照）が、
    // カレンダー自体が選択解除済みなら historical anchor として ghost には出さない。
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a', provider_calendar_id: 'calendar-removed' })],
      plans: [reference('a', '2026-08-11T12:00:00.000Z')],
      selectedCalendars: [],
    });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).resolves.toEqual([]);
  });

  it('選択中のカレンダーの行は引き続き返す', async () => {
    const { supabase } = createSupabase({
      events: [
        mirrorRow({ id: 'a', connection_id: 'connection-1', provider_calendar_id: 'calendar-1' }),
      ],
      selectedCalendars: [
        { user_id: USER_ID, connection_id: 'connection-1', provider_calendar_id: 'calendar-1' },
      ],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['a']);
  });

  it('選択集合の読み取りにも user_id を明示する', async () => {
    const { supabase, selectionTables } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
    });

    await listGhostEvents(supabase, USER_ID, RANGE);

    expect(selectionTables).toHaveLength(1);
    expect(selectionTables[0]?.eq).toHaveBeenCalledWith('user_id', USER_ID);
  });
});

describe('listGhostEvents / 再認証待ちの接続', () => {
  it('reauth_required の接続に属する選択カレンダーの行は返さない', async () => {
    // 同期が止まった接続のミラーは最後に成功した時点のまま更新されなくなる。
    // 古い ghost を fail closed で隠す。
    const { supabase } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
      connections: [{ id: 'connection-1', user_id: USER_ID, status: 'reauth_required' }],
    });

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).resolves.toEqual([]);
  });

  it('active な接続が 1 件も無ければ選択集合の read をスキップする', async () => {
    const { supabase, selectionTables } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
      connections: [{ id: 'connection-1', user_id: USER_ID, status: 'reauth_required' }],
    });

    await listGhostEvents(supabase, USER_ID, RANGE);

    expect(selectionTables).toHaveLength(0);
  });

  it('一部の接続だけ reauth_required でも、他の active な接続の行は巻き込まず返す', async () => {
    const { supabase } = createSupabase({
      events: [
        mirrorRow({ id: 'active-event', connection_id: 'connection-active' }),
        mirrorRow({ id: 'reauth-event', connection_id: 'connection-reauth' }),
      ],
      connections: [
        { id: 'connection-active', user_id: USER_ID, status: 'active' },
        { id: 'connection-reauth', user_id: USER_ID, status: 'reauth_required' },
      ],
    });

    const events = await listGhostEvents(supabase, USER_ID, RANGE);
    expect(events.map((event) => event.id)).toEqual(['active-event']);
  });

  it('active な接続の read にも user_id を明示する', async () => {
    const { supabase, connectionTables } = createSupabase({
      events: [mirrorRow({ id: 'a' })],
    });

    await listGhostEvents(supabase, USER_ID, RANGE);

    expect(connectionTables).toHaveLength(1);
    expect(connectionTables[0]?.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(connectionTables[0]?.eq).toHaveBeenCalledWith('status', 'active');
  });
});

describe('listGhostEvents / エラー', () => {
  it('取得に失敗したら FETCH_FAILED を投げる', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: null, error: { message: 'boom' } })),
      })),
    } as unknown as SupabaseClient<Database>;

    await expect(listGhostEvents(supabase, USER_ID, RANGE)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
  });
});
