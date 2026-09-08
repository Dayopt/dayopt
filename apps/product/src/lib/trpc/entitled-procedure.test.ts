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
