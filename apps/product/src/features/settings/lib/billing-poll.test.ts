import { describe, expect, it } from 'vitest';

import {
  BILLING_POLL_MAX_DURATION_MS,
  hasBillingPollTimedOut,
  shouldContinueBillingPoll,
} from './billing-poll';

describe('shouldContinueBillingPoll', () => {
  it('startedAt が null なら（未開始）ポーリングしない', () => {
    expect(shouldContinueBillingPoll({ startedAt: null, subscriptionStatus: 'free', now: 0 })).toBe(
      false,
    );
  });

  it('subscriptionStatus が未取得（undefined）でも、経過時間内なら継続する', () => {
    expect(
      shouldContinueBillingPoll({ startedAt: 0, subscriptionStatus: undefined, now: 1000 }),
    ).toBe(true);
  });

  it('subscriptionStatus が free のまま、経過時間内なら継続する', () => {
    expect(shouldContinueBillingPoll({ startedAt: 0, subscriptionStatus: 'free', now: 1000 })).toBe(
      true,
    );
  });

  it.each(['active', 'trialing', 'past_due'] as const)(
    'subscriptionStatus が %s（Pro 相当）になったら停止する',
    (status) => {
      expect(
        shouldContinueBillingPoll({ startedAt: 0, subscriptionStatus: status, now: 1000 }),
      ).toBe(false);
    },
  );

  it('最大経過時間ちょうどで停止する（未満のみ継続）', () => {
    expect(
      shouldContinueBillingPoll({
        startedAt: 0,
        subscriptionStatus: 'free',
        now: BILLING_POLL_MAX_DURATION_MS,
      }),
    ).toBe(false);
  });

  it('最大経過時間の直前までは継続する', () => {
    expect(
      shouldContinueBillingPoll({
        startedAt: 0,
        subscriptionStatus: 'free',
        now: BILLING_POLL_MAX_DURATION_MS - 1,
      }),
    ).toBe(true);
  });

  it('最大経過時間を超えたら停止する', () => {
    expect(
      shouldContinueBillingPoll({
        startedAt: 0,
        subscriptionStatus: 'free',
        now: BILLING_POLL_MAX_DURATION_MS + 1,
      }),
    ).toBe(false);
  });

  it('最大経過時間後でも契約が反映済みならtimeoutとして扱わない', () => {
    expect(
      hasBillingPollTimedOut({
        startedAt: 0,
        subscriptionStatus: 'active',
        now: BILLING_POLL_MAX_DURATION_MS,
      }),
    ).toBe(false);
  });

  it('最大経過時間後もfreeならtimeoutとして扱う', () => {
    expect(
      hasBillingPollTimedOut({
        startedAt: 0,
        subscriptionStatus: 'free',
        now: BILLING_POLL_MAX_DURATION_MS,
      }),
    ).toBe(true);
  });

  it('now を省略すると Date.now() を使う（未開始なら影響しない）', () => {
    expect(shouldContinueBillingPoll({ startedAt: null, subscriptionStatus: 'free' })).toBe(false);
  });
});
