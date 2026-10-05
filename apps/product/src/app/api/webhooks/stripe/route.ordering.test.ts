import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route and billing service are real. Only provider/DB transport and delivery
// side effects are synthetic. This mutable profile carries state across events.
const fixture = vi.hoisted(() => ({
  emailEnabled: false,
  mode: 'durable' as 'durable' | 'legacy',
  profilePresent: true,
  deletionReceipt: false,
  deleteBeforeProfileLookup: false,
  event: {
    account: null,
    created: 1_800_000_000,
    data: {
      previous_attributes: undefined as { status: string } | undefined,
      object: {
        customer: 'cus_fixture',
        id: 'sub_old',
        status: 'active',
        mode: 'subscription',
        subscription: 'sub_old',
      },
    },
    id: 'evt_fixture',
    livemode: false,
    type: 'customer.subscription.updated',
  },
  profile: {
    updated_at: '2026-09-30T00:00:00.000Z',
    id: 'user-fixture',
    full_name: null,
    stripe_customer_id: 'cus_fixture',
    subscription_id: null as string | null,
    subscription_status: 'canceled',
  },
}));
const retrieveSubscription = vi.hoisted(() => vi.fn());
const deliveredEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail: deliveredEmail }));
const processed = vi.hoisted(() => vi.fn());
const released = vi.hoisted(() => vi.fn());

vi.mock('@/env', () => ({
  env: {
    STRIPE_ACCOUNT_ID: 'acct_fixture',
    STRIPE_LIVEMODE: 'false',
    STRIPE_WEBHOOK_SECRET: 'fixture',
  },
}));
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://app.dayopt.test' }));
vi.mock('@/lib/stripe/client', () => ({
  requireStripe: () => ({
    accounts: { retrieve: async () => ({ id: 'acct_fixture' }) },
    events: { retrieve: async () => structuredClone(fixture.event) },
    subscriptions: { retrieve: retrieveSubscription },
    webhooks: { constructEvent: () => structuredClone(fixture.event) },
  }),
}));
vi.mock('@/lib/ops/write-fence', () => ({ isWriteFenceEnabled: async () => false }));
vi.mock('@/features/settings/server/billing-lifecycle-mode', () => ({
  resolveBillingLifecycleMode: async () => fixture.mode,
}));
vi.mock('@/lib/analytics/billing-events', () => ({
  trackBillingEvent: async () => true,
  claimFirstPaidInvoice: async () => false,
}));
vi.mock('@/lib/analytics/product-events', () => ({ trackProductEvent: async () => undefined }));
vi.mock('@/lib/analytics/posthog-server', () => ({
  trackPostHogServerEvent: async () => undefined,
}));
vi.mock('./stripe-webhook-idempotency', () => ({
  claimStripeWebhookEvent: async () => 'claimed',
  markStripeWebhookEventProcessed: processed,
  releaseStripeWebhookEvent: released,
}));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: fixture.emailEnabled ? { email: 'fixture@example.test' } : null },
          error: null,
        }),
      },
    },
    from: () => {
      let update: Record<string, unknown> | undefined;
      let customer: string | undefined;
      const filters: Record<string, unknown> = {};
      const builder = {
        update: (values: Record<string, unknown>) => {
          update = values;
          return builder;
        },
        eq: (key: string, value: string) => {
          if (key === 'stripe_customer_id') customer = value;
          filters[key] = value;
          return builder;
        },
        select: () => {
          if (update) {
            if (
              !fixture.profilePresent ||
              customer !== fixture.profile.stripe_customer_id ||
              Object.entries(filters).some(
                ([key, value]) => fixture.profile[key as keyof typeof fixture.profile] !== value,
              )
            )
              return { data: [], error: null };
            Object.assign(fixture.profile, update);
            return { data: [{ id: fixture.profile.id }], error: null };
          }
          return builder;
        },
        is: (key: string, value: null) => {
          filters[key] = value;
          return builder;
        },
        single: async () => {
          if (fixture.deleteBeforeProfileLookup) {
            fixture.profilePresent = false;
            fixture.deletionReceipt = true;
            fixture.deleteBeforeProfileLookup = false;
          }
          return fixture.profilePresent
            ? { data: { ...fixture.profile }, error: null }
            : { data: null, error: { code: 'PGRST116', message: 'No matching profile' } };
        },
        maybeSingle: async () => ({
          data: fixture.profilePresent ? { ...fixture.profile } : null,
          error: null,
        }),
      };
      return builder;
    },
    rpc: async (name: string, input: { p_subscription_id: string }) => {
      if (name === 'classify_billing_customer_event_v1') {
        const classification = fixture.profilePresent
          ? 'live'
          : fixture.deletionReceipt
            ? 'account_deleted'
            : 'unknown_customer';
        return { data: classification, error: null };
      }
      if (name !== 'sync_billing_subscription_deleted_v1') throw new Error('Unexpected RPC');
      if (fixture.profile.subscription_id === input.p_subscription_id) {
        fixture.profile.subscription_id = null;
        fixture.profile.subscription_status = 'canceled';
        return { data: 'updated', error: null };
      }
      return {
        data: fixture.profile.subscription_id === null ? 'already_terminal' : 'stale_subscription',
        error: null,
      };
    },
  }),
}));

import { POST } from './route';

function deliver() {
  return POST(
    new NextRequest('https://app.dayopt.test/api/webhooks/stripe', {
      body: '{}',
      headers: { 'stripe-signature': 'fixture' },
      method: 'POST',
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.emailEnabled = false;
  fixture.event.data.previous_attributes = undefined;
  deliveredEmail.mockResolvedValue({ status: 'sent' });
  fixture.mode = 'durable';
  fixture.profilePresent = true;
  fixture.deletionReceipt = false;
  fixture.deleteBeforeProfileLookup = false;
  fixture.profile.updated_at = '2026-09-30T00:00:00.000Z';
  fixture.profile.subscription_id = 'sub_old';
  fixture.profile.subscription_status = 'active';
  fixture.event.id = 'evt_newer_delete';
  fixture.event.created = 1_800_000_001;
  fixture.event.type = 'customer.subscription.deleted';
  fixture.event.data.object = {
    customer: 'cus_fixture',
    id: 'sub_old',
    status: 'canceled',
    mode: 'subscription',
    subscription: 'sub_old',
  };
  retrieveSubscription.mockResolvedValue({
    id: 'sub_old',
    customer: 'cus_fixture',
    status: 'canceled',
    livemode: false,
  });
});

describe('Stripe webhook delivery order', () => {
  it.each(['durable', 'legacy'] as const)(
    '%s: retry after receipt failure does not duplicate a delivered trial conversion notification',
    async (mode) => {
      fixture.mode = mode;
      fixture.emailEnabled = true;
      fixture.profile.subscription_status = 'trialing';
      fixture.event.type = 'customer.subscription.updated';
      fixture.event.data.object.status = 'active';
      fixture.event.data.previous_attributes = { status: 'trialing' };
      retrieveSubscription.mockResolvedValue({
        id: 'sub_old',
        customer: 'cus_fixture',
        status: 'active',
        livemode: false,
      });
      processed.mockRejectedValueOnce(new Error('Receipt temporarily unavailable'));
      expect((await deliver()).status).toBe(500);
      expect(released).toHaveBeenCalledTimes(1);
      expect(fixture.profile.subscription_status).toBe('active');
      expect((await deliver()).status).toBe(200);
      expect(deliveredEmail).toHaveBeenCalledTimes(1);
      for (const [delivery] of deliveredEmail.mock.calls) {
        expect(delivery).toMatchObject({
          to: 'fixture@example.test',
          context: 'send_trial_conversion_email',
        });
      }
      expect(processed).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['durable', 'legacy'] as const)(
    '%s: recovery followed by an older active trial snapshot sends no trial conversion',
    async (mode) => {
      fixture.mode = mode;
      fixture.emailEnabled = true;
      fixture.profile.subscription_status = 'past_due';
      fixture.event.type = 'customer.subscription.updated';
      fixture.event.id = 'evt_newer_recovery';
      fixture.event.data.object.status = 'active';
      fixture.event.data.previous_attributes = { status: 'past_due' };
      retrieveSubscription.mockResolvedValue({
        id: 'sub_old',
        customer: 'cus_fixture',
        status: 'active',
        livemode: false,
      });
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_status).toBe('active');
      expect(deliveredEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'fixture@example.test',
          context: 'send_payment_recovered_email',
        }),
      );
      fixture.event.id = 'evt_older_trial_end';
      fixture.event.created -= 1;
      fixture.event.data.object.status = 'active';
      fixture.event.data.previous_attributes = { status: 'trialing' };
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_status).toBe('active');
      expect(fixture.profile.subscription_id).toBe('sub_old');
      expect(deliveredEmail).toHaveBeenCalledTimes(1);
      expect(processed).toHaveBeenCalledTimes(2);
      expect(released).not.toHaveBeenCalled();
    },
  );

  it.each(['durable', 'legacy'] as const)(
    '%s: an old still-active subscription update and deletion preserve its replacement',
    async (mode) => {
      fixture.mode = mode;
      fixture.emailEnabled = true;
      fixture.profile.subscription_id = 'sub_new';
      fixture.event.type = 'customer.subscription.updated';
      fixture.event.data.object.status = 'active';
      fixture.event.data.previous_attributes = { status: 'trialing' };
      retrieveSubscription.mockResolvedValue({
        id: 'sub_old',
        customer: 'cus_fixture',
        status: 'active',
        livemode: false,
      });
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_id).toBe('sub_new');
      expect(fixture.profile.subscription_status).toBe('active');
      fixture.event.type = 'customer.subscription.deleted';
      fixture.event.id = 'evt_old_delete';
      fixture.event.data.object.status = 'canceled';
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_id).toBe('sub_new');
      expect(fixture.profile.subscription_status).toBe('active');
      expect(deliveredEmail).not.toHaveBeenCalled();
      expect(processed).toHaveBeenCalledTimes(2);
      expect(released).not.toHaveBeenCalled();
    },
  );
  it.each(['durable', 'legacy'] as const)(
    '%s: authoritative checkout can install a replacement subscription',
    async (mode) => {
      fixture.mode = mode;
      fixture.event.type = 'checkout.session.completed';
      fixture.event.data.object.subscription = 'sub_new';
      retrieveSubscription.mockResolvedValue({
        id: 'sub_new',
        customer: 'cus_fixture',
        status: 'active',
        livemode: false,
      });
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_id).toBe('sub_new');
      expect(fixture.profile.subscription_status).toBe('active');
      expect(processed).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['durable', 'legacy'] as const)(
    '%s: a delayed active snapshot cannot restore a subscription already canceled at Stripe',
    async (mode) => {
      fixture.mode = mode;
      expect((await deliver()).status).toBe(200);
      expect(fixture.profile.subscription_status).toBe('canceled');
      expect(fixture.profile.subscription_id).toBeNull();

      fixture.event.id = 'evt_older_update';
      fixture.event.created = 1_800_000_000;
      fixture.event.type = 'customer.subscription.updated';
      fixture.event.data.object.status = 'active';
      expect((await deliver()).status).toBe(200);

      expect(fixture.profile.subscription_status).toBe('canceled');
      expect(fixture.profile.subscription_id).toBeNull();
    },
  );

  it.each(['durable', 'legacy'] as const)(
    '%s: a delayed update for an ended subscription cannot replace a new subscription',
    async (mode) => {
      fixture.mode = mode;
      fixture.profile.subscription_id = 'sub_new';
      fixture.event.type = 'customer.subscription.updated';
      fixture.event.data.object.status = 'active';

      expect((await deliver()).status).toBe(200);

      expect(fixture.profile.subscription_id).toBe('sub_new');
      expect(fixture.profile.subscription_status).toBe('active');
    },
  );
  it('does not overwrite a deletion committed while the provider read is pending', async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    retrieveSubscription.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    fixture.event.type = 'customer.subscription.updated';
    fixture.event.id = 'evt_pending_update';
    fixture.event.data.object.status = 'active';
    const pending = deliver();
    await reading;
    fixture.event.type = 'customer.subscription.deleted';
    fixture.event.id = 'evt_concurrent_delete';
    expect((await deliver()).status).toBe(200);
    finish({ id: 'sub_old', customer: 'cus_fixture', status: 'active', livemode: false });
    expect((await pending).status).toBe(500);
    expect(fixture.profile.subscription_status).toBe('canceled');
    expect(fixture.profile.subscription_id).toBeNull();
    expect(released).toHaveBeenCalled();
  });

  it('rejects a current Subscription belonging to another Customer', async () => {
    fixture.event.type = 'customer.subscription.updated';
    retrieveSubscription.mockResolvedValue({
      id: 'sub_old',
      customer: 'cus_other',
      status: 'past_due',
      livemode: false,
    });
    expect((await deliver()).status).toBe(500);
    expect(fixture.profile.subscription_status).toBe('active');
    expect(fixture.profile.subscription_id).toBe('sub_old');
    expect(processed).not.toHaveBeenCalled();
  });

  it('a delayed checkout for an ended subscription preserves the new subscription', async () => {
    fixture.profile.subscription_id = 'sub_new';
    fixture.event.type = 'checkout.session.completed';
    expect((await deliver()).status).toBe(200);
    expect(fixture.profile.subscription_id).toBe('sub_new');
    expect(fixture.profile.subscription_status).toBe('active');
  });
  it('rejects a stale read even if concurrent transitions return to the same status', async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    retrieveSubscription.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    fixture.event.type = 'customer.subscription.updated';
    const pending = deliver();
    await reading;
    // A newer transaction completed past_due -> active with the same ID.
    fixture.profile.updated_at = '2026-09-30T00:00:01.000Z';
    finish({ id: 'sub_old', customer: 'cus_fixture', status: 'past_due', livemode: false });
    expect((await pending).status).toBe(500);
    expect(fixture.profile.subscription_status).toBe('active');
    expect(fixture.profile.subscription_id).toBe('sub_old');
  });
  it.each(['checkout.session.completed', 'customer.subscription.updated'])(
    '%s: acknowledges an account covered by a deletion receipt without restoring its state',
    async (type) => {
      fixture.event.type = type;
      fixture.profilePresent = false;
      fixture.deletionReceipt = true;
      expect((await deliver()).status).toBe(200);
      expect(processed).toHaveBeenCalledWith(expect.anything(), fixture.event.id);
      expect(released).not.toHaveBeenCalled();
      expect(retrieveSubscription).not.toHaveBeenCalled();
      expect(fixture.profilePresent).toBe(false);
    },
  );

  it.each(['checkout.session.completed', 'customer.subscription.updated'])(
    '%s: does not acknowledge an unknown Customer without a deletion receipt',
    async (type) => {
      fixture.event.type = type;
      fixture.profilePresent = false;
      expect((await deliver()).status).toBe(500);
      expect(processed).not.toHaveBeenCalled();
      expect(released).toHaveBeenCalledWith(expect.anything(), fixture.event.id);
      expect(retrieveSubscription).not.toHaveBeenCalled();
    },
  );

  it.each(['checkout.session.completed', 'customer.subscription.updated'])(
    '%s: retries if deletion commits between classification and profile lookup',
    async (type) => {
      fixture.event.type = type;
      fixture.deleteBeforeProfileLookup = true;
      expect((await deliver()).status).toBe(500);
      expect(processed).not.toHaveBeenCalled();
      expect(released).toHaveBeenCalledWith(expect.anything(), fixture.event.id);
      expect((await deliver()).status).toBe(200);
      expect(processed).toHaveBeenCalledTimes(1);
      expect(fixture.profilePresent).toBe(false);
    },
  );
});
