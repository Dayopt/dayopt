vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled: vi.fn().mockResolvedValue(false) }));
import { createChainableMock, createMockContext } from '@/lib/test/trpc-test-helpers';
import { entitlementKeys } from '@dayopt/billing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCallerFactory,
  createTRPCRouter,
  entitledProcedure,
  protectedProcedure,
} from './procedures';

const router = createTRPCRouter({
  billing: createTRPCRouter({ startTrial: protectedProcedure.mutation(() => 'started') }),
  review: createTRPCRouter({ getReportPeriod: protectedProcedure.query(() => 'report') }),
  planCommands: createTRPCRouter({
    create: protectedProcedure.mutation(() => 'created'),
    delete: protectedProcedure.mutation(() => 'deleted'),
  }),
  externalCalendar: createTRPCRouter({
    listProviderCalendars: entitledProcedure(entitlementKeys.externalCalendarSync).query(
      () => 'provider',
    ),
  }),
  // MCP scope 表（procedures.ts の MCP_TRPC_SCOPE_REQUIREMENTS）に載る read path。
  // session と OAuth で判定が変わることを同じ path で比べるために使う。
  plans: createTRPCRouter({ list: protectedProcedure.query(() => 'plans') }),
});
const caller = createCallerFactory(router);
function context(status: string, endsAt: string | null = null) {
  const db = {
    from: (table: string) =>
      createChainableMock(
        table === 'profiles'
          ? {
              subscription_status: status,
              app_trial_started_at: endsAt ? '2026-09-01T00:00:00Z' : null,
              app_trial_ends_at: endsAt,
              app_trial_consumed_at: status === 'canceled' ? '2026-08-01T00:00:00Z' : null,
            }
          : null,
      ),
  };
  return { ...createMockContext({ userId: 'user-1' }), supabase: db, subscriptionStatus: 'active' };
}
describe('single-plan procedure boundary', () => {
  beforeEach(() => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it.each(['free', 'canceled'])(
    'preserves saved reads and deletion for %s despite old claims',
    async (status) => {
      const api = caller(context(status) as never);
      await expect(api.review.getReportPeriod()).resolves.toBe('report');
      await expect(api.planCommands.delete()).resolves.toBe('deleted');
      await expect(api.planCommands.create()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.externalCalendar.listProviderCalendars()).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    },
  );
  it.each(['active', 'past_due', 'trialing'])('permits %s', async (status) => {
    await expect(caller(context(status) as never).planCommands.create()).resolves.toBe('created');
  });
  it('uses the current trial deadline at exact expiry', async () => {
    await expect(
      caller(context('free', '2026-09-08T00:00:00.001Z') as never).planCommands.create(),
    ).resolves.toBe('created');
    await expect(
      caller(context('free', '2026-09-08T00:00:00Z') as never).planCommands.create(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not block the trial start behind its own gate', async () => {
    await expect(caller(context('free') as never).billing.startTrial()).resolves.toBe('started');
  });
  it('preserves the disabled switch', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');
    await expect(caller(context('canceled') as never).planCommands.create()).resolves.toBe(
      'created',
    );
  });
  it('continues to require authentication', async () => {
    await expect(
      caller({ ...context('active'), userId: null } as never).review.getReportPeriod(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

/**
 * 1 つの profiles テーブルを複数 caller で共有する mock。
 * `eq('id', userId)` の引数で行を引くため、利用権の判定が「呼び出したユーザー自身の行」を
 * 見ていない実装（取り違え・使い回し）を検出できる。
 */
function sharedProfilesDb(rows: Record<string, Record<string, unknown>>) {
  return {
    from: (table: string) => {
      if (table !== 'profiles') return createChainableMock(null);
      let selectedId: string | null = null;
      const builder = {
        select: () => builder,
        eq: (_column: string, value: string) => {
          selectedId = value;
          return builder;
        },
        single: () =>
          Promise.resolve({
            data: selectedId ? (rows[selectedId] ?? null) : null,
            error: null,
          }),
      };
      return builder;
    },
  };
}

const EXPIRED_PROFILE = {
  subscription_status: 'canceled',
  app_trial_started_at: '2026-07-01T00:00:00Z',
  app_trial_ends_at: '2026-08-15T00:00:00Z',
  app_trial_consumed_at: '2026-08-15T00:00:00Z',
};
const TRIAL_PROFILE = {
  subscription_status: 'free',
  app_trial_started_at: '2026-09-01T00:00:00Z',
  app_trial_ends_at: '2026-10-16T00:00:00Z',
  app_trial_consumed_at: null,
};

describe('single-plan tenant and lifecycle boundary', () => {
  beforeEach(() => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('利用権は呼び出したユーザーごとに決まる（終了した隣人が体験中のユーザーを止めない）', async () => {
    const db = sharedProfilesDb({ 'user-expired': EXPIRED_PROFILE, 'user-trial': TRIAL_PROFILE });
    const expired = caller({
      ...createMockContext({ userId: 'user-expired' }),
      supabase: db,
    } as never);
    const trialing = caller({
      ...createMockContext({ userId: 'user-trial' }),
      supabase: db,
    } as never);

    await expect(trialing.planCommands.create()).resolves.toBe('created');
    await expect(expired.planCommands.create()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // 逆順でも同じ。直前の判定が次の caller へ持ち越されない。
    await expect(trialing.planCommands.create()).resolves.toBe('created');
  });

  it('再契約すると書き込みが戻り、消費済みの体験は戻らない', async () => {
    const profile = { ...EXPIRED_PROFILE };
    const db = sharedProfilesDb({ 'user-1': profile });
    const api = caller({ ...createMockContext({ userId: 'user-1' }), supabase: db } as never);

    await expect(api.planCommands.create()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.review.getReportPeriod()).resolves.toBe('report');

    profile.subscription_status = 'active';

    await expect(api.planCommands.create()).resolves.toBe('created');
    // 再契約は体験を作り直さない（消費済み時刻はそのまま）。
    expect(profile.app_trial_consumed_at).toBe('2026-08-15T00:00:00Z');
  });

  it('MCP からの読み取りは利用権を要求する（同じ path が session では読める）', async () => {
    const db = sharedProfilesDb({ 'user-1': EXPIRED_PROFILE });
    const viaSession = caller({
      ...createMockContext({ userId: 'user-1' }),
      supabase: db,
    } as never);
    const viaMcp = caller({
      ...createMockContext({
        userId: 'user-1',
        authMode: 'oauth',
        oauthExecution: 'mcp_internal',
        oauthScopes: ['read:entries'],
      }),
      supabase: db,
    } as never);

    await expect(viaSession.plans.list()).resolves.toBe('plans');
    await expect(viaMcp.plans.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('体験中は MCP からも読める（前テストが常時 FORBIDDEN で通っていないことの確認）', async () => {
    const db = sharedProfilesDb({ 'user-1': TRIAL_PROFILE });
    const viaMcp = caller({
      ...createMockContext({
        userId: 'user-1',
        authMode: 'oauth',
        oauthExecution: 'mcp_internal',
        oauthScopes: ['read:entries'],
      }),
      supabase: db,
    } as never);

    await expect(viaMcp.plans.list()).resolves.toBe('plans');
  });
});
