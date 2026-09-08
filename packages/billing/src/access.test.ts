import { describe, expect, it } from 'vitest';
import { appTrialDurationMs, resolveBillingAccess, type BillingAccessProfile } from './access';

const start = Date.parse('2026-10-20T12:00:00Z');
const end = start + appTrialDurationMs;
const profile: BillingAccessProfile = {
  subscription_status: 'free',
  app_trial_started_at: new Date(start).toISOString(),
  app_trial_ends_at: new Date(end).toISOString(),
  app_trial_consumed_at: null,
};

describe('single-plan access', () => {
  it.each([
    [start - 1, false],
    [start, true],
    [end - 1, true],
    [end, false],
    [end + 1, false],
  ])('enforces the half-open elapsed-time window at %s', (now, allowed) => {
    expect(resolveBillingAccess(profile, now, true).canUseProduct).toBe(allowed);
  });
  it('does not grant an unstarted or consumed trial', () => {
    expect(
      resolveBillingAccess(
        { ...profile, app_trial_started_at: null, app_trial_ends_at: null },
        start,
        true,
      ).state,
    ).toBe('not_started');
    expect(
      resolveBillingAccess(
        { ...profile, app_trial_consumed_at: new Date(start).toISOString() },
        start,
        true,
      ).canUseProduct,
    ).toBe(false);
  });
  it.each(['active', 'trialing', 'past_due'])(
    'keeps %s subscribers entitled after trial expiry',
    (status) => {
      expect(
        resolveBillingAccess({ ...profile, subscription_status: status }, end, true).state,
      ).toBe('subscribed');
    },
  );
  it('does not restore a consumed trial after cancellation', () => {
    expect(
      resolveBillingAccess(
        {
          ...profile,
          subscription_status: 'canceled',
          app_trial_consumed_at: new Date(start).toISOString(),
        },
        start + 1,
        true,
      ).state,
    ).toBe('expired');
  });
  it('fails closed for malformed dates and preserves the disabled switch', () => {
    expect(
      resolveBillingAccess({ ...profile, app_trial_ends_at: 'invalid' }, start, true).canUseProduct,
    ).toBe(false);
    expect(resolveBillingAccess(profile, end, false).canUseProduct).toBe(true);
  });
});
