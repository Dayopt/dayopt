import { describe, expect, it } from 'vitest';

import {
  getPlanIdForSubscriptionStatus,
  isProSubscriptionStatus,
  isSubscriptionStatus,
  mapStripeSubscriptionStatus,
} from './subscription';

describe('subscription contract', () => {
  it.each(['active', 'trialing', 'past_due'])('recognizes paid status %s', (status) => {
    // 守ること: 有効・試用・支払猶予の既存契約を Pro として扱う。
    expect(isSubscriptionStatus(status)).toBe(true);
    expect(isProSubscriptionStatus(status)).toBe(true);
    expect(getPlanIdForSubscriptionStatus(status)).toBe('pro');
    expect(mapStripeSubscriptionStatus(status)).toBe(status);
  });

  it.each([null, undefined, '', 'unknown', 'ACTIVE', ' active '])(
    'does not grant paid access for an unrecognized status %s',
    (status) => {
      // 守ること: 欠損・未知・表記違いの status で有料扱いにしない。
      expect(isSubscriptionStatus(status)).toBe(false);
      expect(isProSubscriptionStatus(status)).toBe(false);
      expect(getPlanIdForSubscriptionStatus(status)).toBe('free');
    },
  );

  it.each(['free', 'canceled'])('recognizes a non-paying status %s', (status) => {
    // 守ること: 既知の非課金 status と不正 status を区別し、Pro は与えない。
    expect(isSubscriptionStatus(status)).toBe(true);
    expect(isProSubscriptionStatus(status)).toBe(false);
    expect(getPlanIdForSubscriptionStatus(status)).toBe('free');
  });

  it.each(['canceled', 'unpaid', 'incomplete_expired'])(
    'maps terminated Stripe status %s to canceled',
    (status) => {
      // 守ること: 支払終了状態をキャンセルへ写し、有料状態を残さない。
      expect(mapStripeSubscriptionStatus(status)).toBe('canceled');
    },
  );

  it.each(['incomplete', 'paused', 'unknown', ''])(
    'fails closed for unsupported Stripe status %s',
    (status) => {
      // 守ること: 未完了・停止・未知の外部 status から権限を付与しない。
      expect(mapStripeSubscriptionStatus(status)).toBe('free');
    },
  );
});
