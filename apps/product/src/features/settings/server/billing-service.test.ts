import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock } from '@/lib/test/trpc-test-helpers';

import {
  BillingServiceError,
  getBillingInfo,
  getBillingOverview,
  syncSubscriptionStatus,
} from './billing-service';

const stripeMock = vi.hoisted(() => ({
  customers: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { list: vi.fn(), retrieve: vi.fn() },
  billingPortal: { sessions: { create: vi.fn() } },
  paymentMethods: { retrieve: vi.fn() },
  invoices: { list: vi.fn() },
}));

// Stripe SDK モック
vi.mock('@/lib/stripe/client', () => ({
  requireStripe: vi.fn(() => stripeMock),
  getStripe: vi.fn(),
}));

/**
 * profiles テーブルの Supabase モックを作成
 */
function createProfileSupabase(
  profileData: Record<string, unknown> | null,
  error: { message: string; code: string } | null = null,
) {
  const profileMock = createChainableMock(profileData, error);

  return {
    from: (table: string) => {
      if (table === 'profiles') return profileMock;
      return createChainableMock(null);
    },
  } as never;
}

describe('billing-service', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('getBillingInfo', () => {
    it('正常系: active ユーザーの課金情報を返す', async () => {
      const supabase = createProfileSupabase({
        id: 'user-1',
        subscription_status: 'active',
        stripe_customer_id: 'cus_test123',
        subscription_id: 'sub_test456',
      });

      const result = await getBillingInfo(supabase, 'user-1');

      expect(result.subscriptionStatus).toBe('active');
      expect(result.stripeCustomerId).toBe('cus_test123');
      expect(result.subscriptionId).toBe('sub_test456');
    });

    it('正常系: free ユーザー（Stripe未連携）', async () => {
      const supabase = createProfileSupabase({
        id: 'user-1',
        subscription_status: 'free',
        stripe_customer_id: null,
        subscription_id: null,
      });

      const result = await getBillingInfo(supabase, 'user-1');

      expect(result.subscriptionStatus).toBe('free');
      expect(result.stripeCustomerId).toBeNull();
      expect(result.subscriptionId).toBeNull();
    });

    it('subscription_status が null の場合はデフォルト "free"', async () => {
      const supabase = createProfileSupabase({
        id: 'user-1',
        subscription_status: null,
        stripe_customer_id: null,
        subscription_id: null,
      });

      const result = await getBillingInfo(supabase, 'user-1');

      expect(result.subscriptionStatus).toBe('free');
    });

    it('profiles 取得エラーで BillingServiceError', async () => {
      const supabase = createProfileSupabase(null, {
        message: 'Connection refused',
        code: 'PGRST000',
      });

      await expect(getBillingInfo(supabase, 'user-1')).rejects.toThrow(BillingServiceError);
      await expect(getBillingInfo(supabase, 'user-1')).rejects.toThrow(
        'Failed to fetch billing info',
      );
    });
  });

  describe('syncSubscriptionStatus', () => {
    it('Free→Pro: active に更新', async () => {
      const updateMock = createChainableMock([{ id: 'user-1' }]);
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_test123', 'sub_test456', 'active'),
      ).resolves.toBeUndefined();
    });

    it('Pro→Free: canceled に更新', async () => {
      const updateMock = createChainableMock([{ id: 'user-1' }]);
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_test123', null, 'canceled'),
      ).resolves.toBeUndefined();
    });

    it('存在しない stripe_customer_id は更新失敗として扱う', async () => {
      // 0行更新を返す
      const updateMock = createChainableMock([]);
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_nonexistent', null, 'canceled'),
      ).rejects.toMatchObject({
        code: 'UPDATE_FAILED',
        message: 'No billing profile was updated for the Stripe customer',
      });
    });

    it('DB更新エラーで BillingServiceError', async () => {
      const updateMock = createChainableMock(null, {
        message: 'Update failed',
        code: 'PGRST000',
      });
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_test123', 'sub_test456', 'active'),
      ).rejects.toThrow(BillingServiceError);
    });

    it('trialing ステータスの同期', async () => {
      const updateMock = createChainableMock([{ id: 'user-1' }]);
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_test123', 'sub_test456', 'trialing'),
      ).resolves.toBeUndefined();
    });

    it('past_due ステータスの同期', async () => {
      const updateMock = createChainableMock([{ id: 'user-1' }]);
      const supabase = {
        from: () => updateMock,
      } as never;

      await expect(
        syncSubscriptionStatus(supabase, 'cus_test123', 'sub_test456', 'past_due'),
      ).resolves.toBeUndefined();
    });
  });

  describe('状態遷移シナリオ', () => {
    it('trial → active: ステータスが正しく遷移', async () => {
      // Step 1: trialing で sync
      const mock1 = createChainableMock([{ id: 'user-1' }]);
      await syncSubscriptionStatus(
        { from: () => mock1 } as never,
        'cus_test',
        'sub_test',
        'trialing',
      );

      // Step 2: active で sync
      const mock2 = createChainableMock([{ id: 'user-1' }]);
      await syncSubscriptionStatus(
        { from: () => mock2 } as never,
        'cus_test',
        'sub_test',
        'active',
      );

      // 両方とも例外なく完了
    });

    it('active → past_due → canceled: 支払い失敗フロー', async () => {
      const statuses: Array<'active' | 'past_due' | 'canceled'> = [
        'active',
        'past_due',
        'canceled',
      ];

      for (const status of statuses) {
        const mock = createChainableMock([{ id: 'user-1' }]);
        await expect(
          syncSubscriptionStatus(
            { from: () => mock } as never,
            'cus_test',
            status === 'canceled' ? null : 'sub_test',
            status,
          ),
        ).resolves.toBeUndefined();
      }
    });
  });
  describe('getBillingOverview の trialEndsAt', () => {
    const TRIALING_PROFILE = {
      id: 'user-1',
      subscription_status: 'trialing',
      stripe_customer_id: 'cus_test',
      subscription_id: 'sub_test',
    };

    function stubCustomerAndInvoices() {
      stripeMock.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: null },
      });
      stripeMock.invoices.list.mockResolvedValue({ data: [] });
    }

    it('trialing なら trial_end を ISO へ変換して返す', async () => {
      stubCustomerAndInvoices();
      // 2026-08-21T00:00:00Z の unix 秒
      stripeMock.subscriptions.retrieve.mockResolvedValue({ trial_end: 1787270400 });

      const overview = await getBillingOverview(createProfileSupabase(TRIALING_PROFILE), 'user-1');

      expect(overview.trialEndsAt).toBe('2026-08-21T00:00:00.000Z');
    });

    it('trial_end が null なら trialEndsAt も null（Stripe の型は number | null）', async () => {
      stubCustomerAndInvoices();
      stripeMock.subscriptions.retrieve.mockResolvedValue({ trial_end: null });

      const overview = await getBillingOverview(createProfileSupabase(TRIALING_PROFILE), 'user-1');

      expect(overview.trialEndsAt).toBeNull();
    });

    it('Customerに支払い方法が無ければ現在のSubscriptionから取得する', async () => {
      stubCustomerAndInvoices();
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        default_payment_method: 'pm_subscription',
      });
      stripeMock.paymentMethods.retrieve.mockResolvedValue({
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 },
      });

      const overview = await getBillingOverview(
        createProfileSupabase({ ...TRIALING_PROFILE, subscription_status: 'active' }),
        'user-1',
      );

      expect(overview.trialEndsAt).toBeNull();
      expect(overview.paymentMethod).toEqual({
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2034,
      });
      expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledOnce();
      expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith('sub_test');
    });

    it('Subscriptionの支払い方法取得が失敗しても請求画面の他情報を返す', async () => {
      stubCustomerAndInvoices();
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        default_payment_method: 'pm_subscription',
      });
      stripeMock.paymentMethods.retrieve.mockRejectedValue(new Error('Stripe unavailable'));

      const overview = await getBillingOverview(
        createProfileSupabase({ ...TRIALING_PROFILE, subscription_status: 'active' }),
        'user-1',
      );

      expect(overview.paymentMethod).toBeNull();
      expect(overview.invoices).toEqual([]);
      expect(overview.billingInfo.subscriptionStatus).toBe('active');
    });

    it('Customerに支払い方法があればSubscriptionより優先する', async () => {
      stripeMock.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: 'pm_customer' },
      });
      stripeMock.paymentMethods.retrieve.mockResolvedValue({
        card: { brand: 'mastercard', last4: '4444', exp_month: 11, exp_year: 2033 },
      });
      stripeMock.invoices.list.mockResolvedValue({ data: [] });

      const overview = await getBillingOverview(
        createProfileSupabase({ ...TRIALING_PROFILE, subscription_status: 'active' }),
        'user-1',
      );

      expect(overview.paymentMethod).toEqual({
        brand: 'mastercard',
        last4: '4444',
        expMonth: 11,
        expYear: 2033,
      });
      expect(stripeMock.paymentMethods.retrieve).toHaveBeenCalledWith('pm_customer');
      expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it('Stripe が失敗しても支払い方法・請求書を巻き添えにせず trialEndsAt だけ null になる', async () => {
      // この契約が壊れると「試用期限という付加情報」のために Billing 画面が丸ごと落ちる
      stubCustomerAndInvoices();
      stripeMock.invoices.list.mockResolvedValue({
        data: [
          {
            id: 'in_1',
            created: 1787270400,
            amount_paid: 1000,
            currency: 'jpy',
            status: 'paid',
            hosted_invoice_url: null,
          },
        ],
      });
      stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('No such subscription'));

      const overview = await getBillingOverview(createProfileSupabase(TRIALING_PROFILE), 'user-1');

      expect(overview.trialEndsAt).toBeNull();
      expect(overview.invoices).toHaveLength(1);
    });

    it('Stripe 顧客が無ければ Stripe を一切引かず trialEndsAt は null', async () => {
      const overview = await getBillingOverview(
        createProfileSupabase({
          id: 'user-1',
          subscription_status: 'free',
          stripe_customer_id: null,
          subscription_id: null,
        }),
        'user-1',
      );

      expect(overview.trialEndsAt).toBeNull();
      expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
      expect(stripeMock.customers.retrieve).not.toHaveBeenCalled();
    });
  });
});
