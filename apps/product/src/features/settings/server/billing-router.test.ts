import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';

import { createCallerFactory } from '@/lib/trpc/procedures';

import { billingRouter } from './billing-router';

const serviceRoleSupabaseMock = vi.hoisted(() => ({ from: vi.fn() }));
const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const LEGACY_OPERATION_ID = '00000000-0000-4000-8000-000000000099';

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: vi.fn(() => serviceRoleSupabaseMock),
}));

// billing-service モック
vi.mock('./billing-service', () => ({
  getBillingInfo: vi.fn(),
  getBillingOverview: vi.fn(),
  getPaymentMethod: vi.fn(),
  getInvoices: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  BillingServiceError: class BillingServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'BillingServiceError';
    }
  },
}));

// handleServiceError のモック（ServiceError を TRPCError に変換する）
vi.mock('@/lib/trpc/errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trpc/errors')>();
  return {
    ...actual,
    handleServiceError: vi.fn((error: unknown) => {
      throw error;
    }),
  };
});

// billing-service のモックを取得
const billingServiceMock = await import('./billing-service');

const createCaller = createCallerFactory(billingRouter);

describe('billing-router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
  // 機械検証する（#2187 E-3）。ここでの個別 assert（getOverview / getInfo /
  // createCheckoutSession の 3 件）は重複だったため削除した。

  describe('getOverview', () => {
    it('認証済みユーザーの課金情報を返す', async () => {
      const mockOverview = {
        billingInfo: {
          subscriptionStatus: 'active' as const,
          stripeCustomerId: 'cus_test',
          subscriptionId: 'sub_test',
        },
        paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
        invoices: [],
        trialEndsAt: null,
        access: {
          state: 'subscribed' as const,
          canUseProduct: true,
          trialEndsAt: null,
          enforced: false,
        },
      };
      vi.mocked(billingServiceMock.getBillingOverview).mockResolvedValue(mockOverview);

      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      const result = await caller.getOverview();
      expect(result?.billingInfo.subscriptionStatus).toBe('active');
      expect(result?.paymentMethod?.last4).toBe('4242');
    });

    it('free ユーザーの課金情報を返す', async () => {
      const mockOverview = {
        billingInfo: {
          subscriptionStatus: 'free' as const,
          stripeCustomerId: null,
          subscriptionId: null,
        },
        paymentMethod: null,
        invoices: [],
        trialEndsAt: null,
        access: {
          state: 'subscribed' as const,
          canUseProduct: true,
          trialEndsAt: null,
          enforced: false,
        },
      };
      vi.mocked(billingServiceMock.getBillingOverview).mockResolvedValue(mockOverview);

      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      const result = await caller.getOverview();
      expect(result?.billingInfo.subscriptionStatus).toBe('free');
      expect(result?.paymentMethod).toBeNull();
    });
  });

  describe('createCheckoutSession', () => {
    it('メールなしで BAD_REQUEST', async () => {
      const ctx = createMockContext({ userId: 'user-1' });

      // auth.getUser がメールなしのユーザーを返すようモック
      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: null } },
        error: null,
      });

      const caller = createCaller(ctx);

      await expect(caller.createCheckoutSession({ operationId: OPERATION_ID })).rejects.toThrow(
        expect.objectContaining({ code: 'BAD_REQUEST' }),
      );
    });

    it('期限切れsessionは UNAUTHORIZED として扱う', async () => {
      const ctx = createMockContext({ userId: 'user-1' });

      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: null },
        error: Object.assign(new Error('session expired'), {
          status: 401,
          code: 'session_expired',
        }),
      });

      const caller = createCaller(ctx);

      await expect(caller.createCheckoutSession({ operationId: OPERATION_ID })).rejects.toThrow(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      );
    });

    it('caller supplied priceId を拒否する', async () => {
      vi.mocked(billingServiceMock.createCheckoutSession).mockResolvedValue(
        'https://checkout.stripe.com/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      });

      const caller = createCaller(ctx);
      await expect(
        caller.createCheckoutSession({
          operationId: OPERATION_ID,
          priceId: 'price_attacker',
        } as never),
      ).rejects.toThrow();
      expect(billingServiceMock.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('不正な operationId を拒否する', async () => {
      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      await expect(caller.createCheckoutSession({ operationId: 'not-a-uuid' })).rejects.toThrow();
      expect(billingServiceMock.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('service role経路へoperationIdとserver-owned emailを渡す', async () => {
      vi.mocked(billingServiceMock.createCheckoutSession).mockResolvedValue(
        'https://checkout.stripe.com/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      });

      const caller = createCaller(ctx);
      const result = await caller.createCheckoutSession({ operationId: OPERATION_ID });

      expect(result?.url).toBe('https://checkout.stripe.com/test');
      expect(billingServiceMock.createCheckoutSession).toHaveBeenCalledWith(
        serviceRoleSupabaseMock,
        'user-1',
        'test@example.com',
        OPERATION_ID,
      );
    });

    it('旧bundleのinputなし呼び出しへserver operationIdを補う', async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(LEGACY_OPERATION_ID);
      vi.mocked(billingServiceMock.createCheckoutSession).mockResolvedValue(
        'https://checkout.stripe.com/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      });

      const caller = createCaller(ctx);
      await caller.createCheckoutSession();

      expect(billingServiceMock.createCheckoutSession).toHaveBeenCalledWith(
        serviceRoleSupabaseMock,
        'user-1',
        'test@example.com',
        LEGACY_OPERATION_ID,
      );
    });

    it('正常系: checkout URL を返す', async () => {
      vi.mocked(billingServiceMock.createCheckoutSession).mockResolvedValue(
        'https://checkout.stripe.com/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });

      const mockSupabase = ctx.supabase as unknown as Record<string, unknown>;
      (mockSupabase.auth as Record<string, unknown>).getUser = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      });

      const caller = createCaller(ctx);
      const result = await caller.createCheckoutSession({ operationId: OPERATION_ID });

      expect(result?.url).toBe('https://checkout.stripe.com/test');
    });
  });

  describe('createPortalSession', () => {
    it('認証済みで Portal URL を返す', async () => {
      vi.mocked(billingServiceMock.createPortalSession).mockResolvedValue(
        'https://billing.stripe.com/portal/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      const result = await caller.createPortalSession({ operationId: OPERATION_ID });
      expect(result?.url).toBe('https://billing.stripe.com/portal/test');
      expect(billingServiceMock.createPortalSession).toHaveBeenCalledWith(
        serviceRoleSupabaseMock,
        'user-1',
        OPERATION_ID,
      );
    });

    it('旧bundleのinputなし呼び出しへserver operationIdを補う', async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(LEGACY_OPERATION_ID);
      vi.mocked(billingServiceMock.createPortalSession).mockResolvedValue(
        'https://billing.stripe.com/portal/test',
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      await caller.createPortalSession();

      expect(billingServiceMock.createPortalSession).toHaveBeenCalledWith(
        serviceRoleSupabaseMock,
        'user-1',
        LEGACY_OPERATION_ID,
      );
    });

    it('Stripe顧客なしでサービスエラー', async () => {
      vi.mocked(billingServiceMock.createPortalSession).mockRejectedValue(
        new (
          billingServiceMock.BillingServiceError as unknown as new (
            code: string,
            message: string,
          ) => Error
        )('NOT_FOUND', 'No Stripe customer found'),
      );

      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx);

      await expect(caller.createPortalSession({ operationId: OPERATION_ID })).rejects.toThrow(
        'No Stripe customer found',
      );
    });
  });
});
