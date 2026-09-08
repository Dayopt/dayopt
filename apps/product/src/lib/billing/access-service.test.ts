import { createChainableMock } from '@/lib/test/trpc-test-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingAccess, startAppTrial } from './access-service';
const trackBillingEvent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics/billing-events', () => ({ trackBillingEvent }));
const profile = {
  subscription_status: 'free',
  app_trial_started_at: '2026-09-08T00:00:00Z',
  app_trial_ends_at: '2026-10-23T00:00:00Z',
  app_trial_consumed_at: null,
};
describe('server-owned app trial', () => {
  beforeEach(() => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(profile.app_trial_started_at));
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it('does not read new schema or start a trial while disabled', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');
    const from = vi.fn();
    expect((await startAppTrial({ from } as never, 'u')).canUseProduct).toBe(true);
    expect(from).not.toHaveBeenCalled();
    expect(trackBillingEvent).not.toHaveBeenCalled();
  });
  it('conditions the update on unused trial and writes exactly 1080 hours', async () => {
    const write = createChainableMock([{ id: 'u' }]);
    const read = createChainableMock(profile);
    const db = { from: vi.fn().mockReturnValueOnce(write).mockReturnValueOnce(read) };
    expect((await startAppTrial(db as never, 'u')).state).toBe('trial');
    expect(write.update).toHaveBeenCalledWith({
      app_trial_started_at: new Date(profile.app_trial_started_at).toISOString(),
      app_trial_ends_at: new Date(profile.app_trial_ends_at).toISOString(),
    });
    expect(write.eq).toHaveBeenCalledWith('id', 'u');
    expect(write.is).toHaveBeenCalledWith('app_trial_started_at', null);
    expect(write.is).toHaveBeenCalledWith('app_trial_consumed_at', null);
  });
  it('fails closed when current profile cannot be verified', async () => {
    const db = { from: () => createChainableMock(null) };
    await expect(getBillingAccess(db as never, 'u')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
  it('preserves a consumed trial on re-entry', async () => {
    const db = {
      from: vi
        .fn()
        .mockReturnValueOnce(createChainableMock([]))
        .mockReturnValueOnce(
          createChainableMock({
            ...profile,
            subscription_status: 'canceled',
            app_trial_consumed_at: '2026-09-08T00:00:00Z',
          }),
        ),
    };
    expect((await startAppTrial(db as never, 'u')).state).toBe('expired');
    expect(trackBillingEvent).not.toHaveBeenCalled();
  });
});
