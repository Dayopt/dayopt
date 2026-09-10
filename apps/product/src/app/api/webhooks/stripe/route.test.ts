import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';
import { resetWebhookSignatureFailureCaptureForTestsOnly } from '@/lib/webhooks/signature-failure-monitor';

const envMock = vi.hoisted(() => ({
  RESEND_API_KEY: undefined,
  RESEND_FROM_EMAIL: undefined,
  STRIPE_ACCOUNT_ID: 'acct_dayopt',
  STRIPE_LIVEMODE: 'false',
  STRIPE_WEBHOOK_SECRET: 'fixture',
}));
const eventMock = vi.hoisted(() => ({
  account: null as string | null,
  created: 1_700_000_000,
  data: {
    object: {
      customer: 'cus_test123',
      id: 'sub_test456',
    } as Record<string, unknown>,
  },
  id: 'evt_test123',
  livemode: false,
  type: 'customer.subscription.deleted',
}));
// 引数を受ける形にしておく。**引数を無視する mock のままだと「payload / signature /
// secret のどれを渡し間違えても緑」**になり、署名検証を守れない（#2646）。
const constructEvent = vi.hoisted(() =>
  vi.fn((_payload: string, _signature: string, _secret: string): unknown => eventMock),
);
const retrieveAccount = vi.hoisted(() => vi.fn());
const retrieveEvent = vi.hoisted(() => vi.fn());
const retrieveSubscription = vi.hoisted(() => vi.fn());
const syncDeletedSubscriptionStatus = vi.hoisted(() => vi.fn());
const syncSubscriptionStatus = vi.hoisted(() => vi.fn());
const classifyBillingCustomerEvent = vi.hoisted(() => vi.fn());
const resolveBillingLifecycleMode = vi.hoisted(() => vi.fn());
const claimStripeWebhookEvent = vi.hoisted(() => vi.fn());
const markStripeWebhookEventProcessed = vi.hoisted(() => vi.fn());
const releaseStripeWebhookEvent = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const profileMaybeSingle = vi.hoisted(() => vi.fn());
const writeFenceMaybeSingle = vi.hoisted(() => vi.fn());
const getUserById = vi.hoisted(() => vi.fn());
const trackBillingEvent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics/billing-events', () => ({ trackBillingEvent }));
const trackProductEvent = vi.hoisted(() => vi.fn());
const profileConsume = vi.hoisted(() =>
  vi.fn(() => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) })),
);
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() =>
  vi.fn((table: string) => ({
    update: profileConsume,
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: table === 'write_fence_control' ? writeFenceMaybeSingle : profileMaybeSingle,
      })),
    })),
  })),
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://app.dayopt.test' }));
vi.mock('@/lib/stripe/client', () => ({
  requireStripe: () => ({
    accounts: { retrieve: retrieveAccount },
    events: { retrieve: retrieveEvent },
    subscriptions: { retrieve: retrieveSubscription },
    webhooks: { constructEvent },
  }),
}));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    auth: { admin: { getUserById } },
    from,
    rpc,
  }),
}));
vi.mock('@/lib/analytics/product-events', () => ({ trackProductEvent }));
vi.mock('@/features/settings/server/billing-service', () => ({
  classifyBillingCustomerEvent,
  syncDeletedSubscriptionStatus,
  syncSubscriptionStatus,
}));
vi.mock('@/features/settings/server/billing-lifecycle-mode', () => ({
  resolveBillingLifecycleMode,
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: vi.fn(),
  captureUnexpectedError,
  observeAuthOperation: vi.fn((_name: string, operation: () => unknown) => operation()),
}));
vi.mock('./stripe-webhook-idempotency', () => ({
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
}));

import { POST } from './route';

function request(overrides: { body?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest('https://app.dayopt.test/api/webhooks/stripe', {
    body: overrides.body ?? '{}',
    headers: overrides.headers ?? { 'stripe-signature': 'signed' },
    method: 'POST',
  });
}

beforeEach(() => {
  trackBillingEvent.mockResolvedValue(true);
  vi.clearAllMocks();
  resetWriteFenceCacheForTestsOnly();
  resetWebhookSignatureFailureCaptureForTestsOnly();
  envMock.STRIPE_WEBHOOK_SECRET = 'fixture';
  constructEvent.mockImplementation(() => eventMock);
  eventMock.account = null;
  eventMock.livemode = false;
  eventMock.type = 'customer.subscription.deleted';
  eventMock.data.object = {
    customer: 'cus_test123',
    id: 'sub_test456',
  };
  retrieveAccount.mockResolvedValue({ id: 'acct_dayopt' });
  retrieveEvent.mockImplementation(async () => ({ ...eventMock }));
  retrieveSubscription.mockResolvedValue({ status: 'trialing', trial_end: null });
  claimStripeWebhookEvent.mockResolvedValue('claimed');
  markStripeWebhookEventProcessed.mockResolvedValue(undefined);
  releaseStripeWebhookEvent.mockResolvedValue(undefined);
  profileMaybeSingle.mockResolvedValue({ data: null, error: null });
  writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: false }, error: null });
  getUserById.mockResolvedValue({ data: { user: null }, error: null });
  trackProductEvent.mockResolvedValue(undefined);
  classifyBillingCustomerEvent.mockResolvedValue('live');
  syncSubscriptionStatus.mockResolvedValue(undefined);
  resolveBillingLifecycleMode.mockResolvedValue('durable');
  rpc.mockReturnValue({
    abortSignal: vi.fn(async () => ({ data: 1, error: null })),
  });
});

describe('Stripe webhook route', () => {
  it('idempotency claim失敗をSentryへ通知して500を返す', async () => {
    const claimError = new Error('database claim failed');
    claimStripeWebhookEvent.mockRejectedValueOnce(claimError);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      claimError,
      expect.objectContaining({
        feature: 'billing',
        operation: 'claim',
        source: 'stripe_webhook',
      }),
    );
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('subscription checkoutをprocessedにした後で一度だけ記録し、duplicateでは再記録しない', async () => {
    eventMock.type = 'checkout.session.completed';
    eventMock.data.object = {
      customer: 'cus_test123',
      id: 'cs_test456',
      mode: 'subscription',
      subscription: 'sub_test456',
    };
    profileMaybeSingle.mockResolvedValueOnce({
      data: { id: 'user-1', full_name: 'Test User' },
      error: null,
    });

    const firstResponse = await POST(request());

    expect(firstResponse.status).toBe(200);
    expect(syncSubscriptionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'cus_test123',
      'sub_test456',
      'trialing',
    );
    expect(markStripeWebhookEventProcessed).toHaveBeenCalledWith(expect.anything(), 'evt_test123');
    expect(trackProductEvent).toHaveBeenCalledWith({
      eventName: 'subscription_started',
      userId: 'user-1',
    });
    expect(markStripeWebhookEventProcessed.mock.invocationCallOrder[0]).toBeLessThan(
      trackProductEvent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    claimStripeWebhookEvent.mockResolvedValueOnce('already_processed');
    const duplicateResponse = await POST(request());

    expect(duplicateResponse.status).toBe(200);
    expect(trackProductEvent).toHaveBeenCalledTimes(1);
  });

  it.each(['subscription_create', 'subscription_cycle'])(
    'records trusted %s invoice once',
    async (reason) => {
      eventMock.type = 'invoice.paid';
      eventMock.data.object = {
        id: 'in_paid',
        customer: 'cus_test123',
        status: 'paid',
        amount_paid: 500,
        billing_reason: reason,
      };
      profileMaybeSingle.mockResolvedValue({ data: { id: 'user-1' }, error: null });
      expect((await POST(request())).status).toBe(200);
      expect(profileConsume).toHaveBeenCalledWith({
        app_trial_consumed_at: new Date(eventMock.created * 1_000).toISOString(),
      });
      expect(trackBillingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'in_paid',
          userId: 'user-1',
          eventName:
            reason === 'subscription_create'
              ? 'subscription_payment_succeeded'
              : 'subscription_renewal_succeeded',
        }),
      );
      claimStripeWebhookEvent.mockResolvedValueOnce('already_processed');
      expect((await POST(request())).status).toBe(200);
      expect(trackBillingEvent).toHaveBeenCalledTimes(1);
    },
  );

  it('releases a paid invoice receipt when analytics persistence fails', async () => {
    eventMock.type = 'invoice.paid';
    eventMock.data.object = {
      id: 'in_paid',
      customer: 'cus_test123',
      status: 'paid',
      amount_paid: 500,
      billing_reason: 'subscription_create',
    };
    profileMaybeSingle.mockResolvedValue({ data: { id: 'user-1' }, error: null });
    trackBillingEvent.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(500);
    expect(markStripeWebhookEventProcessed).not.toHaveBeenCalled();
    expect(releaseStripeWebhookEvent).toHaveBeenCalled();
  });

  it.each([
    'account_deleted',
    'account_deleting',
    'already_terminal',
    'stale_subscription',
  ] as const)('%sは通知せずterminal eventとして処理する', async (outcome) => {
    syncDeletedSubscriptionStatus.mockResolvedValue(outcome);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(syncDeletedSubscriptionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'cus_test123',
      'sub_test456',
    );
    // fence check は毎回 write_fence_control を読むが、profile lookup（通知用）は
    // 起きていないことだけを確認する。
    if (outcome !== 'already_terminal') expect(from).not.toHaveBeenCalledWith('profiles');
    expect(markStripeWebhookEventProcessed).toHaveBeenCalledWith(expect.anything(), 'evt_test123');
    expect(releaseStripeWebhookEvent).not.toHaveBeenCalled();
  });

  it('unknown Customerはclaimを解放してretry可能な500を返す', async () => {
    syncDeletedSubscriptionStatus.mockRejectedValue(
      new Error('No live or deleted billing account matched'),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(markStripeWebhookEventProcessed).not.toHaveBeenCalled();
    expect(releaseStripeWebhookEvent).toHaveBeenCalledWith(expect.anything(), 'evt_test123');
  });

  it('削除済みaccountの遅延payment failureは通知せず終端する', async () => {
    eventMock.type = 'invoice.payment_failed';
    eventMock.data.object = { customer: 'cus_test123', id: 'in_test456' };
    classifyBillingCustomerEvent.mockResolvedValue('account_deleted');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(classifyBillingCustomerEvent).toHaveBeenCalledWith(expect.anything(), 'cus_test123');
    // fence check は毎回 write_fence_control を読むが、profile lookup（通知用）は
    // 起きていないことだけを確認する。
    expect(from).not.toHaveBeenCalledWith('profiles');
    expect(markStripeWebhookEventProcessed).toHaveBeenCalled();
  });

  it('unknown Customerのpayment failureはclaimを解放して500にする', async () => {
    eventMock.type = 'invoice.payment_failed';
    eventMock.data.object = { customer: 'cus_unknown', id: 'in_unknown' };
    classifyBillingCustomerEvent.mockRejectedValue(new Error('unknown Customer'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(markStripeWebhookEventProcessed).not.toHaveBeenCalled();
    expect(releaseStripeWebhookEvent).toHaveBeenCalledWith(expect.anything(), 'evt_test123');
  });

  it('未対応eventを成功扱いにしない', async () => {
    eventMock.type = 'customer.created';

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(markStripeWebhookEventProcessed).not.toHaveBeenCalled();
    expect(releaseStripeWebhookEvent).toHaveBeenCalledWith(expect.anything(), 'evt_test123');
  });

  it('activation前は現行のsubscription削除経路を維持する', async () => {
    resolveBillingLifecycleMode.mockResolvedValue('legacy');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(syncSubscriptionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'cus_test123',
      null,
      'canceled',
    );
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
    expect(retrieveEvent).not.toHaveBeenCalled();
  });

  it('照合後の業務入力をprovider Eventへ固定する', async () => {
    retrieveEvent.mockResolvedValue({
      ...eventMock,
      data: {
        object: {
          customer: 'cus_provider123',
          id: 'sub_provider456',
        },
      },
    });
    syncDeletedSubscriptionStatus.mockResolvedValue('account_deleted');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(syncDeletedSubscriptionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'cus_provider123',
      'sub_provider456',
    );
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      'cus_test123',
      'sub_test456',
    );
  });

  it('event mode不一致はDB claim前に拒否する', async () => {
    eventMock.livemode = true;

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('event account不一致はDB claim前に拒否する', async () => {
    eventMock.account = 'acct_other';

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('API keyのaccount不一致はplatform eventでもDB claim前に拒否する', async () => {
    retrieveAccount.mockResolvedValue({ id: 'acct_other' });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(retrieveEvent).toHaveBeenCalledWith('evt_test123', {
      maxNetworkRetries: 0,
      timeout: 5_000,
    });
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('provider Eventを取得できない場合はDB claim前にretry可能な500を返す', async () => {
    retrieveEvent.mockRejectedValue(new Error('provider unavailable'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('write fence が有効な時は claim 前に 503 を返す（予約の滞留を避ける）', async () => {
    writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: true }, error: null });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncSubscriptionStatus).not.toHaveBeenCalled();
  });
});

/**
 * 署名検証の負のケース。
 *
 * 実測（#2646）: `route.ts` の署名ヘッダ欠如ガード（401）を削除しても webhook 関連
 * 51 件がすべて pass した。既存の test は常に正しいヘッダしか送らず、`constructEvent`
 * も throw しない固定 mock だったため、**401 を assert する test が 1 本も無かった**。
 * 検証を素通りした request が claim（冪等性の予約）と業務処理へ到達しないことまで見る。
 */
describe('Stripe webhook 署名検証', () => {
  it('署名ヘッダが無い request を401で拒否し、業務処理へ進めない', async () => {
    const response = await POST(request({ headers: {} }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Missing signature' });
    expect(constructEvent).not.toHaveBeenCalled();
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('署名検証がthrowしたら401で拒否し、業務処理へ進めない', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const responses = await Promise.all(Array.from({ length: 5 }, () => POST(request())));

    expect(responses.every((response) => response.status === 401)).toBe(true);
    await expect(responses[0]!.json()).resolves.toEqual({ error: 'Invalid signature' });
    expect(captureUnexpectedError).toHaveBeenCalledOnce();
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'billing',
      operation: 'signature_verification',
      route: '/api/webhooks/stripe',
      source: 'stripe_webhook',
    });
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    expect(syncDeletedSubscriptionStatus).not.toHaveBeenCalled();
  });

  // issue #2646 は「早期 return」と書いているが、実装は 500 を返す（`route.ts` の
  // `Webhook secret not configured`）。現行挙動をそのまま固定する。
  it('webhook secret未設定は500で止め、Sentryへconfigurationとして送る', async () => {
    envMock.STRIPE_WEBHOOK_SECRET = '';

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Webhook secret not configured' });
    expect(captureUnexpectedError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'configuration', source: 'stripe_webhook' }),
    );
    expect(constructEvent).not.toHaveBeenCalled();
    expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
  });

  /**
   * ここだけ mock ではなく実 SDK の `constructEvent` を通す。mock throw は「throw したら
   * 401 になる」ことしか証明せず、**secret の受け渡し先を取り違えた類のバグは拾えない**。
   * `apps/product` は `stripe` を依存に持つので新規依存は要らない。
   */
  describe('実SDKでの署名検証', () => {
    // 署名検証（constructEvent / generateTestHeaderString）は webhook secret だけを使う
    // HMAC で、API key は一度も参照されない。Stripe key の形をした literal を置くと
    // secrets:check が正しく反応するので、鍵らしくない文字列を渡す。
    const realStripe = new Stripe('unused-api-key-signature-verification-only');
    const signedPayload = JSON.stringify(eventMock);

    function withRealVerification() {
      constructEvent.mockImplementation((payload: string, signature: string, secret: string) =>
        realStripe.webhooks.constructEvent(payload, signature, secret),
      );
    }

    it('正しいsecretで署名したpayloadは検証を通り、冪等性のclaimまで進む', async () => {
      withRealVerification();
      const signature = realStripe.webhooks.generateTestHeaderString({
        payload: signedPayload,
        secret: 'fixture',
      });

      const response = await POST(
        request({ body: signedPayload, headers: { 'stripe-signature': signature } }),
      );

      expect(response.status).not.toBe(401);
      expect(claimStripeWebhookEvent).toHaveBeenCalledOnce();
    });

    it('別のsecretで署名したpayloadは401で拒否する', async () => {
      withRealVerification();
      const signature = realStripe.webhooks.generateTestHeaderString({
        payload: signedPayload,
        secret: 'wrong-secret',
      });

      const response = await POST(
        request({ body: signedPayload, headers: { 'stripe-signature': signature } }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid signature' });
      expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
    });
  });
});
