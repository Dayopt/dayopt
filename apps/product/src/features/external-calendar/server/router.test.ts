import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock, createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const listConnections = vi.hoisted(() => vi.fn());
const getSyncStatus = vi.hoisted(() => vi.fn());
const listProviderCalendars = vi.hoisted(() => vi.fn());
const updateSelectedCalendars = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());
const listGhostEvents = vi.hoisted(() => vi.fn());
const setEventDismissed = vi.hoisted(() => vi.fn());
const syncConnection = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
const isBillingEnforced = vi.hoisted(() => vi.fn(() => false));
const isGoogleCalendarConfigured = vi.hoisted(() => vi.fn());
const resolveRedirectUri = vi.hoisted(() => vi.fn());

vi.mock('./connection-service', () => ({
  listConnections,
  getSyncStatus,
  listProviderCalendars,
  updateSelectedCalendars,
  disconnect,
}));
vi.mock('./sync-service', () => ({ syncConnection }));
vi.mock('./event-query-service', () => ({ listGhostEvents }));
vi.mock('./event-command-service', () => ({ setEventDismissed }));
vi.mock('./google-oauth', () => ({ isGoogleCalendarConfigured, resolveRedirectUri }));
vi.mock('@/lib/rate-limit/upstash', () => ({
  calendarSyncNowRateLimit: { limit: rateLimit },
  // protectedProcedure が毎リクエスト参照する。ここでは常に成功させる。
  trpcUserRateLimit: { limit: vi.fn().mockResolvedValue({ success: true }) },
}));
// flag だけ差し替え、capability map の判定（hasEntitlementForStatus）は本物を使う。
// map を mock すると「どのキーで弾いたか」を検証できなくなる。
vi.mock('@/lib/billing/enforcement-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforcement-flag')>()),
  isBillingEnforced,
}));

import { externalCalendarRouter, TRPC_TIME_BUDGET_MS } from './router';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';

const createCaller = createCallerFactory(externalCalendarRouter);

function caller(overrides: { requestStartedAt?: number } = {}) {
  return createCaller({
    ...createMockContext({ userId: USER_ID, ...overrides }),
    supabase: {
      from: () =>
        createChainableMock({
          subscription_status: 'free',
          app_trial_started_at: null,
          app_trial_ends_at: null,
          app_trial_consumed_at: null,
        }),
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  isBillingEnforced.mockReturnValue(false);
  rateLimit.mockResolvedValue({ success: true });
  syncConnection.mockResolvedValue({ outcome: 'synced', calendarsSynced: 1, calendarsFailed: 0 });
  listConnections.mockResolvedValue([]);
  getSyncStatus.mockResolvedValue({ connection: {}, calendars: [] });
  listProviderCalendars.mockResolvedValue([]);
  updateSelectedCalendars.mockResolvedValue(undefined);
  disconnect.mockResolvedValue(undefined);
  listGhostEvents.mockResolvedValue([]);
  setEventDismissed.mockResolvedValue(undefined);
  isGoogleCalendarConfigured.mockReturnValue(true);
  resolveRedirectUri.mockReturnValue(
    'https://app.dayopt.app/api/integrations/google-calendar/callback',
  );
});

describe('externalCalendarRouter — 認可', () => {
  it('entitledProcedure は BILLING_ENFORCED off で素通りする', async () => {
    await expect(caller().listProviderCalendars({ connectionId: CONNECTION_ID })).resolves.toEqual(
      [],
    );
    await expect(caller().syncNow({ connectionId: CONNECTION_ID })).resolves.toMatchObject({
      outcome: 'synced',
    });
  });

  // 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
  // 機械検証する（#2187 E-3）。ここでの個別 assert は重複だったため削除した。
});

describe('externalCalendarRouter — listProviderCalendars', () => {
  // tRPC route の maxDuration に対する予算を listProviderCalendars へ渡す（#2079）。
  // syncNow / updateSelectedCalendars と同じ anchor（ctx.requestStartedAt）を使うことを固定する。
  it('deadlineAt を ctx.requestStartedAt 起点で計算する', async () => {
    const requestStartedAt = 1_700_000_000_000;
    await caller({ requestStartedAt }).listProviderCalendars({ connectionId: CONNECTION_ID });

    expect(listProviderCalendars).toHaveBeenCalledWith(
      USER_ID,
      CONNECTION_ID,
      requestStartedAt + TRPC_TIME_BUDGET_MS,
    );
  });
});

describe('externalCalendarRouter — connection availability', () => {
  it('設定と redirect origin が一致すると available=true', async () => {
    await expect(
      caller().getConnectionAvailability({ origin: 'https://app.dayopt.app' }),
    ).resolves.toEqual({ available: true });
  });

  it('設定不足または protocol の違う redirect は available=false', async () => {
    isGoogleCalendarConfigured.mockReturnValue(false);
    await expect(
      caller().getConnectionAvailability({ origin: 'https://app.dayopt.app' }),
    ).resolves.toEqual({ available: false });

    isGoogleCalendarConfigured.mockReturnValue(true);
    resolveRedirectUri.mockReturnValue(
      'http://app.dayopt.app/api/integrations/google-calendar/callback',
    );
    await expect(
      caller().getConnectionAvailability({ origin: 'https://app.dayopt.app' }),
    ).resolves.toEqual({ available: false });
  });

  it('origin 以外や http(s) 以外は BAD_REQUEST', async () => {
    await expect(
      caller().getConnectionAvailability({ origin: 'https://app.dayopt.app/path' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().getConnectionAvailability({ origin: 'ftp://app.dayopt.app' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('externalCalendarRouter — syncNow rate limit', () => {
  it('超過で TOO_MANY_REQUESTS を返し、sync を呼ばない', async () => {
    rateLimit.mockResolvedValue({ success: false });

    await expect(caller().syncNow({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(syncConnection).not.toHaveBeenCalled();
  });

  it('rate-limit サービス障害は SERVICE_UNAVAILABLE', async () => {
    rateLimit.mockRejectedValue(new Error('upstash down'));

    await expect(caller().syncNow({ connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  // tRPC route の maxDuration に対する予算を syncConnection へ渡す（#1965）。anchor は
  // ctx.requestStartedAt（handler 入口）で、procedure 内で呼んだ Date.now() ではない
  // ことを固定する — auth 解決・rate limit の所要時間を予算計算から漏らさないため
  // （risk-reviewer 指摘、PR #2075）。
  it('deadlineAt を ctx.requestStartedAt 起点で計算する', async () => {
    const requestStartedAt = 1_700_000_000_000;
    await caller({ requestStartedAt }).syncNow({ connectionId: CONNECTION_ID });

    expect(syncConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      deadlineAt: requestStartedAt + TRPC_TIME_BUDGET_MS,
    });
  });
});

describe('externalCalendarRouter — updateSelectedCalendars', () => {
  it('選択更新後に同期を kick する', async () => {
    const requestStartedAt = 1_700_000_000_000;
    await caller({ requestStartedAt }).updateSelectedCalendars({
      connectionId: CONNECTION_ID,
      calendars: [{ providerCalendarId: 'cal-a', calendarName: 'A' }],
    });

    expect(updateSelectedCalendars).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, [
      { providerCalendarId: 'cal-a', calendarName: 'A' },
    ]);
    // deadlineAt は ctx.requestStartedAt 起点（updateSelectedCalendars の DB 書き込みが
    // 先に完了した後、実際に procedure 内で Date.now() を呼んだ場合より前の値になるはず。
    // #1965、risk-reviewer 指摘 PR #2075）。
    expect(syncConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      deadlineAt: requestStartedAt + TRPC_TIME_BUDGET_MS,
    });
  });

  it('calendarName 省略は null に正規化して渡す', async () => {
    await caller().updateSelectedCalendars({
      connectionId: CONNECTION_ID,
      calendars: [{ providerCalendarId: 'cal-a' }],
    });

    expect(updateSelectedCalendars).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, [
      { providerCalendarId: 'cal-a', calendarName: null },
    ]);
  });
});

describe('externalCalendarRouter — disconnect', () => {
  it('protectedProcedure なので Pro でなくても切断できる', async () => {
    await expect(caller().disconnect({ connectionId: CONNECTION_ID })).resolves.toEqual({
      success: true,
    });
    expect(disconnect).toHaveBeenCalledWith(USER_ID, CONNECTION_ID);
  });
});

describe('externalCalendarRouter — 入力バリデーション', () => {
  it('connectionId が uuid でなければ BAD_REQUEST', async () => {
    await expect(caller().getSyncStatus({ connectionId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('externalCalendarRouter — listEvents', () => {
  const RANGE = {
    startDate: '2026-08-10T00:00:00.000Z',
    endDate: '2026-08-17T00:00:00.000Z',
  };

  it('範囲を service へそのまま渡す', async () => {
    await expect(caller().listEvents(RANGE)).resolves.toEqual([]);

    expect(listGhostEvents).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      startAt: RANGE.startDate,
      endAt: RANGE.endDate,
    });
  });

  it('期限終了後も保持済み外部予定を閲覧できる', async () => {
    isBillingEnforced.mockReturnValue(true);
    await expect(caller().listEvents(RANGE)).resolves.toEqual([]);
    expect(listGhostEvents).toHaveBeenCalled();
  });

  // 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
  // 機械検証する（#2187 E-3）。ここでの個別 assert は重複だったため削除した。

  it.each([
    ['終了が開始より前', { startDate: RANGE.endDate, endDate: RANGE.startDate }],
    ['開始と終了が同じ', { startDate: RANGE.startDate, endDate: RANGE.startDate }],
    [
      '62 日を超える',
      { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' },
    ],
    ['日時として不正', { startDate: 'not-a-date', endDate: RANGE.endDate }],
  ])('%s 範囲は BAD_REQUEST', async (_label, input) => {
    await expect(caller().listEvents(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(listGhostEvents).not.toHaveBeenCalled();
  });

  it('62 日ちょうどは通す', async () => {
    await expect(
      caller().listEvents({
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-03-04T00:00:00.000Z',
      }),
    ).resolves.toEqual([]);
  });
});

describe('externalCalendarRouter — dismissEvent', () => {
  it('dismissed=true で service へそのまま渡す', async () => {
    await expect(caller().dismissEvent({ eventId: EVENT_ID, dismissed: true })).resolves.toEqual({
      success: true,
    });

    expect(setEventDismissed).toHaveBeenCalledWith(expect.anything(), USER_ID, EVENT_ID, true);
  });

  it('dismissed=false で undo を渡す', async () => {
    await expect(caller().dismissEvent({ eventId: EVENT_ID, dismissed: false })).resolves.toEqual({
      success: true,
    });

    expect(setEventDismissed).toHaveBeenCalledWith(expect.anything(), USER_ID, EVENT_ID, false);
  });

  it('entitledProcedure(external_calendar_sync) なので BILLING_ENFORCED on の未 Pro ユーザーは弾かれる', async () => {
    isBillingEnforced.mockReturnValue(true);

    await expect(
      caller().dismissEvent({ eventId: EVENT_ID, dismissed: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(setEventDismissed).not.toHaveBeenCalled();
  });

  // 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
  // 機械検証する（#2187 E-3）。ここでの個別 assert は重複だったため削除した。

  it('eventId が uuid でなければ BAD_REQUEST', async () => {
    await expect(
      caller().dismissEvent({ eventId: 'not-a-uuid', dismissed: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(setEventDismissed).not.toHaveBeenCalled();
  });

  it('対象が見つからない場合は NOT_FOUND', async () => {
    setEventDismissed.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { code: 'NOT_FOUND' }),
    );

    await expect(
      caller().dismissEvent({ eventId: EVENT_ID, dismissed: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
