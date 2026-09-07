import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listGhostEvents } from '@/features/external-calendar/server/event-query-service';
import { fetchReportUnconvertedExternalEvents } from '@/features/review/server/report-fetchers';

import {
  createSupabase,
  mirrorRow,
  reference,
  type MirrorRow,
} from './external-calendar-ghost-fixture';

const captureUnexpectedError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const USER_ID = 'user-1';
const NOW = new Date('2026-08-13T00:00:00.000Z');
// Production の定数から期待値を作らず、±90 日という契約を固定する。
const RANGE = { startAt: '2026-05-15T00:00:00.000Z', endAt: '2026-11-11T00:00:00.000Z' };

type Seed = Parameters<typeof createSupabase>[0];

async function expectBoth(seed: Seed, expectedIds: string[]) {
  // 各 query の predicate を実際に適用する同一 fixture を、独立した client へ渡す。
  const calendar = createSupabase(seed);
  const report = createSupabase(seed);
  const calendarEvents = await listGhostEvents(calendar.supabase, USER_ID, RANGE);
  const reportEvents = await fetchReportUnconvertedExternalEvents(report.supabase, USER_ID, NOW);
  expect(calendarEvents.map((event) => event.id).sort()).toEqual([...expectedIds].sort());
  expect(reportEvents.map((event) => event.id).sort()).toEqual([...expectedIds].sort());
  return { calendar, report };
}

beforeEach(() => vi.clearAllMocks());

describe('カレンダー / レポートの外部予定選択契約', () => {
  it.each<[string, Partial<MirrorRow>]>([
    ['cancelled', { status: 'cancelled' }],
    ['未知の状態', { status: 'tentative' }],
    ['非表示', { dismissed_at: NOW.toISOString() }],
    ['孤児', { connection_id: null }],
    ['別ユーザー', { user_id: 'user-2' }],
    ['開始なし', { start_at: null }],
    ['終了なし', { end_at: null }],
    ['上端に開始', { start_at: RANGE.endAt, end_at: '2026-11-11T01:00:00.000Z' }],
    ['下端に終了', { start_at: '2026-05-14T23:00:00.000Z', end_at: RANGE.startAt }],
  ])('%s を除外し、正常な予定だけを残す', async (_label, overrides) => {
    await expectBoth(
      { events: [mirrorRow({ id: 'visible' }), mirrorRow({ id: 'excluded', ...overrides })] },
      ['visible'],
    );
  });

  it('両端を跨ぐ予定と、両端に接する内側の予定を残す', async () => {
    await expectBoth(
      {
        events: [
          mirrorRow({
            id: 'cross-start',
            start_at: '2026-05-14T23:00:00.000Z',
            end_at: '2026-05-15T01:00:00.000Z',
          }),
          mirrorRow({
            id: 'cross-end',
            start_at: '2026-11-10T23:00:00.000Z',
            end_at: '2026-11-11T01:00:00.000Z',
          }),
          mirrorRow({ id: 'inside', start_at: RANGE.startAt, end_at: RANGE.endAt }),
        ],
      },
      ['cross-start', 'cross-end', 'inside'],
    );
  });

  it.each(['plans', 'records'] as const)('%s の生きた参照だけで除外する', async (table) => {
    await expectBoth(
      {
        events: ['converted', 'deleted-reference', 'other-user-reference', 'unconverted'].map(
          (id) => mirrorRow({ id }),
        ),
        [table]: [
          reference('converted'),
          reference('deleted-reference', NOW.toISOString()),
          { ...reference('other-user-reference'), user_id: 'user-2' },
        ],
      },
      ['deleted-reference', 'other-user-reference', 'unconverted'],
    );
  });

  it.each(['reauth_required', 'disconnected', 'unknown'])(
    '%s の接続だけを除外する',
    async (status) => {
      await expectBoth(
        {
          events: [
            mirrorRow({ id: 'visible' }),
            mirrorRow({ id: 'excluded', connection_id: 'inactive' }),
          ],
          connections: [
            { id: 'connection-1', user_id: USER_ID, status: 'active' },
            { id: 'inactive', user_id: USER_ID, status },
          ],
        },
        ['visible'],
      );
    },
  );

  it('同名カレンダーでも接続が違えば選択済みと見なさない', async () => {
    await expectBoth(
      {
        events: [
          mirrorRow({ id: 'visible' }),
          mirrorRow({ id: 'wrong-connection', connection_id: 'connection-2' }),
          mirrorRow({ id: 'removed', provider_calendar_id: 'removed' }),
        ],
        selectedCalendars: [
          { user_id: USER_ID, connection_id: 'connection-1', provider_calendar_id: 'calendar-1' },
        ],
        plans: [reference('removed', NOW.toISOString())],
      },
      ['visible'],
    );
  });

  it.each(['connections', 'selectedCalendars'] as const)(
    '%s の他ユーザー行では選択を成立させない',
    async (table) => {
      const seed: Seed = { events: [mirrorRow({ id: 'excluded' })] };
      if (table === 'connections')
        seed.connections = [{ id: 'connection-1', user_id: 'user-2', status: 'active' }];
      else
        seed.selectedCalendars = [
          { user_id: 'user-2', connection_id: 'connection-1', provider_calendar_id: 'calendar-1' },
        ];
      await expectBoth(seed, []);
    },
  );

  it('選択がなければ空、ミラーが空でも空を返す', async () => {
    await expectBoth({ events: [mirrorRow({ id: 'excluded' })], selectedCalendars: [] }, []);
    await expectBoth({ events: [] }, []);
  });

  it('除外される行だけで1ページ埋まっても次ページの予定を返す', async () => {
    const hidden = Array.from({ length: 150 }, (_, index) =>
      mirrorRow({ id: `a-${String(index).padStart(4, '0')}` }),
    );
    const { calendar, report } = await expectBoth(
      {
        events: [...hidden, mirrorRow({ id: 'z-visible' })],
        plans: hidden.map((row) => reference(row.id)),
      },
      ['z-visible'],
    );
    expect(calendar.eventTables).toHaveLength(2);
    expect(report.eventTables).toHaveLength(2);
    for (const client of [calendar, report]) {
      expect(client.eventTables[0]?.limit).toHaveBeenCalledWith(150);
      expect(client.eventTables[1]?.gt).toHaveBeenCalledWith('id', 'a-0149');
    }
  });

  it('上限時はカレンダーがエラー、レポートが通知付き部分結果を返す', async () => {
    const events = Array.from({ length: 3001 }, (_, index) =>
      mirrorRow({ id: `e-${String(index).padStart(4, '0')}` }),
    );
    const calendar = createSupabase({ events });
    const report = createSupabase({ events });
    await expect(listGhostEvents(calendar.supabase, USER_ID, RANGE)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
    const result = await fetchReportUnconvertedExternalEvents(report.supabase, USER_ID, NOW);
    expect(result.map((event) => event.id)).toEqual(events.slice(0, 3000).map((event) => event.id));
    expect(calendar.eventTables).toHaveLength(20);
    expect(report.eventTables).toHaveLength(20);
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'ghost_query_batch_limit' }),
    );
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'ghost_count_batch_limit' }),
    );
  });

  it('表示期間だけを取得するカレンダーと±90日を数えるレポートの差を維持する', async () => {
    const seed = {
      events: [
        mirrorRow({ id: 'this-week' }),
        mirrorRow({
          id: 'next-month',
          start_at: '2026-09-01T00:00:00.000Z',
          end_at: '2026-09-01T01:00:00.000Z',
        }),
      ],
    };
    const calendar = await listGhostEvents(createSupabase(seed).supabase, USER_ID, {
      startAt: '2026-08-10T00:00:00.000Z',
      endAt: '2026-08-17T00:00:00.000Z',
    });
    const report = await fetchReportUnconvertedExternalEvents(
      createSupabase(seed).supabase,
      USER_ID,
      NOW,
    );
    expect(calendar.map((event) => event.id)).toEqual(['this-week']);
    expect(report.map((event) => event.id).sort()).toEqual(['next-month', 'this-week']);
  });
});
