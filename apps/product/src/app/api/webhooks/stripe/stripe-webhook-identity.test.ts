import { describe, expect, it, vi } from 'vitest';

import {
  matchesStripeWebhookIdentity,
  parseStripeWebhookIdentity,
  verifyStripeWebhookIdentity,
} from '@/lib/stripe/webhook-identity';

describe('Stripe webhook identity', () => {
  it('accountとmodeの設定を正規identityへ変換する', () => {
    expect(
      parseStripeWebhookIdentity({
        accountId: ' acct_dayopt ',
        livemode: 'true',
      }),
    ).toEqual({
      accountId: 'acct_dayopt',
      livemode: true,
    });
  });

  it.each([
    { accountId: undefined, livemode: 'true' },
    { accountId: 'invalid', livemode: 'true' },
    { accountId: 'acct_dayopt', livemode: undefined },
    { accountId: 'acct_dayopt', livemode: '1' },
  ])('不完全な設定を拒否する', (input) => {
    expect(parseStripeWebhookIdentity(input)).toBeNull();
  });

  it('platform eventはmode一致を要求する', () => {
    const expected = { accountId: 'acct_dayopt', livemode: true };

    expect(matchesStripeWebhookIdentity({ livemode: true }, expected)).toBe(true);
    expect(matchesStripeWebhookIdentity({ livemode: false }, expected)).toBe(false);
  });

  it('account付きeventはconfigured accountだけを許可する', () => {
    const expected = { accountId: 'acct_dayopt', livemode: false };

    expect(
      matchesStripeWebhookIdentity({ account: 'acct_dayopt', livemode: false }, expected),
    ).toBe(true);
    expect(matchesStripeWebhookIdentity({ account: 'acct_other', livemode: false }, expected)).toBe(
      false,
    );
  });

  it('provider Eventとcurrent Accountが一致するplatform eventを許可する', async () => {
    const event = {
      created: 1_700_000_000,
      id: 'evt_dayopt',
      livemode: false,
      type: 'customer.subscription.deleted',
    } as const;
    const retrieveAccount = vi.fn().mockResolvedValue({ id: 'acct_dayopt' });
    const retrieveEvent = vi.fn().mockResolvedValue(event);

    await expect(
      verifyStripeWebhookIdentity(
        {
          accounts: { retrieve: retrieveAccount },
          events: { retrieve: retrieveEvent },
        } as never,
        event,
        { accountId: 'acct_dayopt', livemode: false },
      ),
    ).resolves.toEqual(event);
    expect(retrieveAccount).toHaveBeenCalledWith({
      maxNetworkRetries: 0,
      timeout: 5_000,
    });
    expect(retrieveEvent).toHaveBeenCalledWith('evt_dayopt', {
      maxNetworkRetries: 0,
      timeout: 5_000,
    });
  });

  it.each([
    {
      name: 'API account',
      account: { id: 'acct_other' },
      providerEvent: {
        created: 1_700_000_000,
        id: 'evt_dayopt',
        livemode: false,
        type: 'customer.subscription.deleted',
      },
    },
    {
      name: 'provider Event type',
      account: { id: 'acct_dayopt' },
      providerEvent: {
        created: 1_700_000_000,
        id: 'evt_dayopt',
        livemode: false,
        type: 'customer.subscription.updated',
      },
    },
  ])('$name不一致を拒否する', async ({ account, providerEvent }) => {
    const event = {
      created: 1_700_000_000,
      id: 'evt_dayopt',
      livemode: false,
      type: 'customer.subscription.deleted',
    } as const;

    await expect(
      verifyStripeWebhookIdentity(
        {
          accounts: { retrieve: vi.fn().mockResolvedValue(account) },
          events: { retrieve: vi.fn().mockResolvedValue(providerEvent) },
        } as never,
        event,
        { accountId: 'acct_dayopt', livemode: false },
      ),
    ).resolves.toBeNull();
  });
});
