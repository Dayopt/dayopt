import 'server-only';

import type Stripe from 'stripe';

const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_]+$/;
const STRIPE_IDENTITY_TIMEOUT_MS = 5_000;

export type StripeWebhookIdentity = Readonly<{
  accountId: string;
  livemode: boolean;
}>;

export function parseStripeWebhookIdentity(input: {
  accountId: string | undefined;
  livemode: string | undefined;
}): StripeWebhookIdentity | null {
  const accountId = input.accountId?.trim();
  if (
    accountId === undefined ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(accountId) ||
    (input.livemode !== 'true' && input.livemode !== 'false')
  ) {
    return null;
  }

  return {
    accountId,
    livemode: input.livemode === 'true',
  };
}

export function matchesStripeWebhookIdentity(
  event: Pick<Stripe.Event, 'account' | 'livemode'>,
  expected: StripeWebhookIdentity,
): boolean {
  return (
    event.livemode === expected.livemode &&
    (event.account === undefined || event.account === null || event.account === expected.accountId)
  );
}

function normalizeEventAccount(account: string | null | undefined): string | null {
  return account ?? null;
}

/** 署名payloadとStripe API keyのaccount identityをprovider Eventで照合する。 */
export async function verifyStripeWebhookIdentity(
  stripe: Pick<Stripe, 'accounts' | 'events'>,
  event: Pick<Stripe.Event, 'account' | 'created' | 'id' | 'livemode' | 'type'>,
  expected: StripeWebhookIdentity,
): Promise<Stripe.Event | null> {
  if (!matchesStripeWebhookIdentity(event, expected)) return null;

  const [account, providerEvent] = await Promise.all([
    stripe.accounts.retrieve({
      maxNetworkRetries: 0,
      timeout: STRIPE_IDENTITY_TIMEOUT_MS,
    }),
    stripe.events.retrieve(event.id, {
      maxNetworkRetries: 0,
      timeout: STRIPE_IDENTITY_TIMEOUT_MS,
    }),
  ]);

  const matches =
    account.id === expected.accountId &&
    providerEvent.id === event.id &&
    providerEvent.type === event.type &&
    providerEvent.created === event.created &&
    normalizeEventAccount(providerEvent.account) === normalizeEventAccount(event.account) &&
    matchesStripeWebhookIdentity(providerEvent, expected);

  return matches ? providerEvent : null;
}
