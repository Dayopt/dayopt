import { isProSubscriptionStatus } from './subscription';

/** Elapsed days, independent of display timezone and DST. */
export const appTrialDays = 45;
export const appTrialDurationMs = appTrialDays * 24 * 60 * 60 * 1_000;

export type BillingAccessState = 'not_started' | 'trial' | 'subscribed' | 'expired';
export interface BillingAccessProfile {
  subscription_status: string;
  app_trial_started_at: string | null;
  app_trial_ends_at: string | null;
  app_trial_consumed_at: string | null;
}
export interface BillingAccess {
  state: BillingAccessState;
  canUseProduct: boolean;
  trialEndsAt: string | null;
  enforced: boolean;
}

/** Claims are display hints only; callers pass a freshly read server profile. */
export function resolveBillingAccess(
  profile: BillingAccessProfile,
  now: number,
  enforced: boolean,
): BillingAccess {
  let state: BillingAccessState;
  if (isProSubscriptionStatus(profile.subscription_status)) {
    state = 'subscribed';
  } else if (profile.app_trial_consumed_at !== null) {
    state = 'expired';
  } else if (profile.app_trial_started_at === null && profile.app_trial_ends_at === null) {
    state = 'not_started';
  } else if (
    profile.app_trial_started_at !== null &&
    profile.app_trial_ends_at !== null &&
    Date.parse(profile.app_trial_started_at) <= now &&
    now < Date.parse(profile.app_trial_ends_at)
  ) {
    state = 'trial';
  } else {
    state = 'expired';
  }
  return {
    state,
    canUseProduct: !enforced || state === 'trial' || state === 'subscribed',
    trialEndsAt: profile.app_trial_ends_at,
    enforced,
  };
}
