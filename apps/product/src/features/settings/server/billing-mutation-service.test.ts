import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock } from '@/lib/test/trpc-test-helpers';

import {
  BillingMutationError,
  createCheckoutSession,
  createPortalSession,
} from './billing-mutation-service';

const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const LEASE_ID = '00000000-0000-4000-8000-000000000002';
const LEASE_EXPIRES_AT = '2040-01-01T00:05:00.000Z';
const PROVIDER_RETRY_DEADLINE_AT = '2040-01-01T23:00:00.000Z';
const RESPONSE_EXPIRES_AT = '2040-01-01T00:10:00.000Z';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/test';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test';
const STRIPE_CREDENTIAL_ENV_NAME = ['STRIPE', 'SECRET', 'KEY'].join('_');
const STRIPE_TEST_CREDENTIAL = ['sk', 'test', 'fixture'].join('_');

const stripeMock = vi.hoisted(() => ({
  accounts: {
    retrieve: vi.fn(),
  },
  customers: {
    create: vi.fn(),
    list: vi.fn(),
  },
  checkout: {
    sessions: {
      create: vi.fn(),
      expire: vi.fn(),
      list: vi.fn(),
    },
  },
  subscriptions: { list: vi.fn() },
  billingPortal: { sessions: { create: vi.fn() } },
}));

vi.mock('@/lib/stripe/client', () => ({
  requireStripe: vi.fn(() => stripeMock),
}));

vi.mock('@/lib/app-url', () => ({
  getAppUrl: vi.fn(() => 'https://app.dayopt.test'),
}));

interface RpcReply {
  data: unknown;
  error: null | { code: string; message: string };
}

function billingClaimRow(
  result:
    | 'abandoned'
    | 'account_closing'
    | 'claimed'
    | 'completed'
    | 'contention'
    | 'reconcile'
    | 'response_expired',
) {
  if (result === 'contention') {
    return {
      canonical_operation_id: null,
      lease_expires_at: null,
      lease_id: null,
      provider_object_id: null,
      provider_response_expires_at: null,
      provider_response_url: null,
      provider_retry_deadline_at: null,
      result,
    };
  }

  if (result === 'account_closing') {
    return {
      canonical_operation_id: OPERATION_ID,
      lease_expires_at: LEASE_EXPIRES_AT,
      lease_id: LEASE_ID,
      provider_object_id: null,
      provider_response_expires_at: null,
      provider_response_url: null,
      provider_retry_deadline_at: null,
      result,
    };
  }

  if (result === 'claimed') {
    return {
      canonical_operation_id: OPERATION_ID,
      lease_expires_at: LEASE_EXPIRES_AT,
      lease_id: LEASE_ID,
      provider_object_id: null,
      provider_response_expires_at: null,
      provider_response_url: null,
      provider_retry_deadline_at: null,
      result,
    };
  }

  if (result === 'reconcile') {
    return {
      canonical_operation_id: OPERATION_ID,
      lease_expires_at: null,
      lease_id: null,
      provider_object_id: null,
      provider_response_expires_at: null,
      provider_response_url: null,
      provider_retry_deadline_at: PROVIDER_RETRY_DEADLINE_AT,
      result,
    };
  }

  if (result === 'completed') {
    return {
      canonical_operation_id: OPERATION_ID,
      lease_expires_at: null,
      lease_id: null,
      provider_object_id: 'cs_test_completed',
      provider_response_expires_at: RESPONSE_EXPIRES_AT,
      provider_response_url: CHECKOUT_URL,
      provider_retry_deadline_at: PROVIDER_RETRY_DEADLINE_AT,
      result,
    };
  }

  if (result === 'response_expired') {
    return {
      canonical_operation_id: OPERATION_ID,
      lease_expires_at: null,
      lease_id: null,
      provider_object_id: 'cs_test_expired',
      provider_response_expires_at: null,
      provider_response_url: null,
      provider_retry_deadline_at: PROVIDER_RETRY_DEADLINE_AT,
      result,
    };
  }

  return {
    canonical_operation_id: OPERATION_ID,
    lease_expires_at: null,
    lease_id: null,
    provider_object_id: null,
    provider_response_expires_at: null,
    provider_response_url: null,
    provider_retry_deadline_at: PROVIDER_RETRY_DEADLINE_AT,
    result,
  };
}

function customerClaimRow(result: 'claimed' | 'existing' | 'reconcile' | 'recover') {
  return {
    lease_expires_at: result === 'claimed' ? LEASE_EXPIRES_AT : null,
    lease_id: result === 'claimed' ? LEASE_ID : null,
    provider_customer_id: result === 'existing' ? 'cus_existing' : null,
    provider_retry_deadline_at:
      result === 'reconcile' || result === 'recover' ? PROVIDER_RETRY_DEADLINE_AT : null,
    result,
  };
}

function createSupabase(profileCustomerId: string | null, replies: Record<string, RpcReply[]>) {
  const profileMock = createChainableMock({ stripe_customer_id: profileCustomerId });
  const rpc = vi.fn(async (name: string) => {
    const reply = replies[name]?.shift();
    if (!reply) throw new Error(`Unexpected RPC: ${name}`);
    return reply;
  });

  return {
    client: {
      from: (table: string) => {
        if (table !== 'profiles') throw new Error(`Unexpected table: ${table}`);
        return profileMock;
      },
      rpc,
    } as never,
    rpc,
  };
}

function reply(data: unknown): RpcReply {
  return { data, error: null };
}

function checkoutSession(
  overrides: Partial<{
    id: string;
    metadata: Record<string, string>;
    status: 'complete' | 'expired' | 'open';
    url: string | null;
  }> = {},
) {
  return {
    id: 'cs_test_created',
    metadata: {
      dayopt_operation_id: OPERATION_ID,
      supabase_user_id: 'user-1',
    },
    status: 'open' as const,
    url: CHECKOUT_URL,
    ...overrides,
  };
}

describe('billing-mutation-service', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PRO_PRICE_ID', 'price_server_pro');
    vi.stubEnv(STRIPE_CREDENTIAL_ENV_NAME, STRIPE_TEST_CREDENTIAL);
    vi.stubEnv('STRIPE_ACCOUNT_ID', 'acct_dayopt_test');
    vi.stubEnv('STRIPE_LIVEMODE', 'false');
    stripeMock.accounts.retrieve.mockResolvedValue({ id: 'acct_dayopt_test' });
    stripeMock.customers.list.mockResolvedValue({ data: [], has_more: false });
    stripeMock.customers.create.mockResolvedValue({
      id: 'cus_created',
      metadata: { supabase_user_id: 'user-1' },
    });
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false });
    stripeMock.checkout.sessions.expire.mockResolvedValue(checkoutSession({ status: 'expired' }));
    stripeMock.checkout.sessions.create.mockResolvedValue(checkoutSession());
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      id: 'bps_test_created',
      url: PORTAL_URL,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([false, true])('starts Checkout durably with single-plan mode %s', async (enforced) => {
    vi.stubEnv('BILLING_ENFORCED', String(enforced));
    const { client, rpc } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [
        reply([billingClaimRow('claimed')]),
        reply([billingClaimRow('reconcile')]),
      ],
      reconcile_billing_mutation_v4: [reply('completed')],
      start_billing_mutation_v2: [reply('started')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'Test@Example.com', OPERATION_ID),
    ).resolves.toBe(CHECKOUT_URL);

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: OPERATION_ID,
        customer: 'cus_existing',
        line_items: [{ price: 'price_server_pro', quantity: 1 }],
        metadata: {
          dayopt_operation_id: OPERATION_ID,
          supabase_user_id: 'user-1',
        },
        ...(enforced ? {} : { subscription_data: { trial_period_days: expect.any(Number) } }),
      }),
      {
        idempotencyKey: `dayopt-billing-checkout-v1-${OPERATION_ID}`,
      },
    );
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_billing_mutation_v3',
      'start_billing_mutation_v2',
      'claim_billing_mutation_v3',
      'reconcile_billing_mutation_v4',
    ]);
  });

  it('returns a retained terminal Checkout URL without another provider mutation', async () => {
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('completed')])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).resolves.toBe(CHECKOUT_URL);

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('fails terminally after the retained Checkout URL expires', async () => {
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('response_expired')])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_RESPONSE_EXPIRED',
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('creates and binds a missing Customer only after durable start', async () => {
    const { client, rpc } = createSupabase(null, {
      claim_billing_customer_provisioning_v2: [
        reply([customerClaimRow('claimed')]),
        reply([customerClaimRow('reconcile')]),
      ],
      claim_billing_mutation_v3: [
        reply([billingClaimRow('claimed')]),
        reply([billingClaimRow('reconcile')]),
      ],
      complete_billing_customer_provisioning_v2: [reply('cus_created')],
      reconcile_billing_mutation_v4: [reply('completed')],
      start_billing_customer_provisioning_v2: [reply('started')],
      start_billing_mutation_v2: [reply('started')],
    });

    await createCheckoutSession(client, 'user-1', 'Test@Example.com', OPERATION_ID);

    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      {
        email: 'test@example.com',
        metadata: { supabase_user_id: 'user-1' },
      },
      {
        idempotencyKey: `dayopt-billing-customer-v1-${OPERATION_ID}`,
      },
    );
    expect(stripeMock.customers.list).toHaveBeenCalledWith({
      email: 'test@example.com',
      limit: 100,
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_billing_mutation_v3',
      'claim_billing_customer_provisioning_v2',
      'start_billing_customer_provisioning_v2',
      'claim_billing_customer_provisioning_v2',
      'complete_billing_customer_provisioning_v2',
      'start_billing_mutation_v2',
      'claim_billing_mutation_v3',
      'reconcile_billing_mutation_v4',
    ]);
  });

  it('recovers an unknown Customer response by metadata without another create', async () => {
    stripeMock.customers.list.mockResolvedValue({
      data: [{ id: 'cus_recovered', metadata: { supabase_user_id: 'user-1' } }],
      has_more: false,
    });
    const { client } = createSupabase(null, {
      claim_billing_customer_provisioning_v2: [reply([customerClaimRow('reconcile')])],
      claim_billing_mutation_v3: [
        reply([billingClaimRow('claimed')]),
        reply([billingClaimRow('reconcile')]),
      ],
      complete_billing_customer_provisioning_v2: [reply('cus_recovered')],
      reconcile_billing_mutation_v4: [reply('completed')],
      start_billing_mutation_v2: [reply('started')],
    });

    await createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID);

    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_recovered' }),
      expect.anything(),
    );
  });

  it('rechecks trial history after recovering the Customer binding', async () => {
    stripeMock.customers.list.mockResolvedValue({
      data: [{ id: 'cus_recovered', metadata: { supabase_user_id: 'user-1' } }],
      has_more: false,
    });
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_canceled', status: 'canceled' }],
      has_more: false,
    });
    const { client } = createSupabase(null, {
      claim_billing_customer_provisioning_v2: [reply([customerClaimRow('reconcile')])],
      claim_billing_mutation_v3: [
        reply([billingClaimRow('claimed')]),
        reply([billingClaimRow('reconcile')]),
      ],
      complete_billing_customer_provisioning_v2: [reply('cus_recovered')],
      reconcile_billing_mutation_v4: [reply('completed')],
      start_billing_mutation_v2: [reply('started')],
    });

    await createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID);

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ subscription_data: expect.anything() }),
      expect.anything(),
    );
  });

  it('does not create Checkout for a Customer with an existing live subscription', async () => {
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_active', status: 'active' }],
      has_more: false,
    });
    const { client, rpc } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [
        reply([billingClaimRow('claimed')]),
        reply([billingClaimRow('reconcile')]),
      ],
      reconcile_billing_mutation_v4: [reply('abandoned')],
      start_billing_mutation_v2: [reply('started')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_CHECKOUT_NOT_AVAILABLE',
    });

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_billing_mutation_v3',
      'start_billing_mutation_v2',
      'claim_billing_mutation_v3',
      'reconcile_billing_mutation_v4',
    ]);
  });

  it('expires the current operation Checkout before terminalizing a blocking replay', async () => {
    stripeMock.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_active', status: 'active' }],
      has_more: false,
    });
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [checkoutSession()],
      has_more: false,
    });
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
      reconcile_billing_mutation_v4: [reply('abandoned')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_CHECKOUT_NOT_AVAILABLE',
    });

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith(
      'cs_test_created',
      {},
      {
        idempotencyKey: 'dayopt-billing-checkout-expire-v1-cs_test_created',
      },
    );
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('terminalizes an exhausted Customer response instead of restarting its POST window', async () => {
    const { client } = createSupabase(null, {
      abandon_billing_customer_provisioning_v2: [reply(true)],
      claim_billing_customer_provisioning_v2: [reply([customerClaimRow('recover')])],
      claim_billing_mutation_v3: [reply([billingClaimRow('claimed')])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_RECOVERY_EXHAUSTED',
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rechecks the Customer retry deadline immediately before create', async () => {
    const { client } = createSupabase(null, {
      abandon_billing_customer_provisioning_v2: [reply(true)],
      claim_billing_customer_provisioning_v2: [
        reply([customerClaimRow('claimed')]),
        reply([customerClaimRow('recover')]),
      ],
      claim_billing_mutation_v3: [reply([billingClaimRow('claimed')])],
      start_billing_customer_provisioning_v2: [reply('started')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_RECOVERY_EXHAUSTED',
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('does not start a Customer POST inside the five-minute safety margin', async () => {
    const nearDeadlineClaim = {
      ...customerClaimRow('reconcile'),
      provider_retry_deadline_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    };
    const { client } = createSupabase(null, {
      claim_billing_customer_provisioning_v2: [
        reply([customerClaimRow('claimed')]),
        reply([nearDeadlineClaim]),
      ],
      claim_billing_mutation_v3: [reply([billingClaimRow('claimed')])],
      start_billing_customer_provisioning_v2: [reply('started')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_OPERATION_CONFLICT',
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('reuses an open Checkout Session recovered by operation metadata', async () => {
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [checkoutSession()],
      has_more: false,
    });
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
      reconcile_billing_mutation_v4: [reply('completed')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).resolves.toBe(CHECKOUT_URL);

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it('expires a prior open Checkout Session before creating the current operation', async () => {
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [
        checkoutSession({
          id: 'cs_test_previous',
          metadata: {
            dayopt_operation_id: '00000000-0000-4000-8000-000000000099',
            supabase_user_id: 'user-1',
          },
        }),
      ],
      has_more: false,
    });
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
      reconcile_billing_mutation_v4: [reply('completed')],
    });

    await createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID);

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith(
      'cs_test_previous',
      {},
      {
        idempotencyKey: 'dayopt-billing-checkout-expire-v1-cs_test_previous',
      },
    );
  });

  it.each(['https://evil.example/checkout', 'https://checkout.stripe.com:444/c/pay/test'])(
    'rejects an untrusted Checkout redirect URL: %s',
    async (url) => {
      stripeMock.checkout.sessions.create.mockResolvedValue(checkoutSession({ url }));
      const { client, rpc } = createSupabase('cus_existing', {
        claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
      });

      await expect(
        createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
      ).rejects.toMatchObject({
        code: 'BILLING_CONTRACT_INVALID',
      });

      expect(rpc).not.toHaveBeenCalledWith('reconcile_billing_mutation_v4', expect.anything());
    },
  );

  it('does not return a Checkout URL when completion reconciliation is abandoned', async () => {
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
      reconcile_billing_mutation_v4: [reply('abandoned')],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_RECOVERY_EXHAUSTED',
    });
  });

  it('does not start a Checkout POST inside the five-minute safety margin', async () => {
    const nearDeadlineClaim = {
      ...billingClaimRow('reconcile'),
      provider_retry_deadline_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    };
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([nearDeadlineClaim])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'BILLING_OPERATION_CONFLICT',
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it('creates a Portal Session with the canonical operation idempotency key', async () => {
    const portalClaim = {
      ...billingClaimRow('reconcile'),
      provider_object_id: null,
    };
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([portalClaim])],
      reconcile_billing_mutation_v4: [reply('completed')],
    });

    await expect(createPortalSession(client, 'user-1', OPERATION_ID)).resolves.toBe(PORTAL_URL);

    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
      {
        customer: 'cus_existing',
        return_url: 'https://app.dayopt.test/settings/billing?portal_return=true',
      },
      {
        idempotencyKey: `dayopt-billing-portal-v1-${OPERATION_ID}`,
      },
    );
  });

  it('Stripe accountが設定と違う場合はprovider mutation前に停止する', async () => {
    stripeMock.accounts.retrieve.mockResolvedValue({ id: 'acct_other' });
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toMatchObject({
      code: 'STRIPE_IDENTITY_MISMATCH',
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('Stripe keyとlive modeが食い違う場合はAccount APIより前に停止する', async () => {
    vi.stubEnv('STRIPE_LIVEMODE', 'true');
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([billingClaimRow('reconcile')])],
    });

    await expect(createPortalSession(client, 'user-1', OPERATION_ID)).rejects.toMatchObject({
      code: 'STRIPE_IDENTITY_NOT_CONFIGURED',
    });
    expect(stripeMock.accounts.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('does not return a Portal URL when completion reconciliation is abandoned', async () => {
    const portalClaim = {
      ...billingClaimRow('reconcile'),
      provider_object_id: null,
    };
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([portalClaim])],
      reconcile_billing_mutation_v4: [reply('abandoned')],
    });

    await expect(createPortalSession(client, 'user-1', OPERATION_ID)).rejects.toMatchObject({
      code: 'BILLING_RECOVERY_EXHAUSTED',
    });
  });

  it('does not start a Portal POST inside the five-minute safety margin', async () => {
    const nearDeadlineClaim = {
      ...billingClaimRow('reconcile'),
      provider_retry_deadline_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    };
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([nearDeadlineClaim])],
    });

    await expect(createPortalSession(client, 'user-1', OPERATION_ID)).rejects.toMatchObject({
      code: 'BILLING_OPERATION_CONFLICT',
    });
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed nullable claim shape', async () => {
    const malformedClaim = {
      ...billingClaimRow('claimed'),
      provider_response_url: CHECKOUT_URL,
    };
    const { client } = createSupabase('cus_existing', {
      claim_billing_mutation_v3: [reply([malformedClaim])],
    });

    await expect(
      createCheckoutSession(client, 'user-1', 'test@example.com', OPERATION_ID),
    ).rejects.toBeInstanceOf(BillingMutationError);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
