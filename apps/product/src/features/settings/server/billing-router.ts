/**
 * tRPC Router: Billing
 * Stripe サブスクリプション管理API
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getBillingAccess, startAppTrial } from '@/lib/billing/access-service';
import { observeAuthOperation } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

import {
  createCheckoutSession,
  createPortalSession,
  getBillingInfo,
  getBillingOverview,
  getInvoices,
  getPaymentMethod,
} from './billing-service';

const billingOperationInput = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict()
  .optional();

// Mixed-version bridge: one release may still have an open browser bundle
// that calls these mutations without input. Remove after that release drains.
function resolveBillingOperationId(input: z.infer<typeof billingOperationInput>): string {
  return input?.operationId ?? crypto.randomUUID();
}

/** 課金管理のtRPCルーター（Stripeサブスクリプション・Checkout・Portal・請求書） */
export const billingRouter = createTRPCRouter({
  getAccess: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await getBillingAccess(ctx.supabase, ctx.userId);
    } catch (error) {
      handleServiceError(error);
    }
  }),
  startTrial: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await startAppTrial(createServiceRoleClient(), ctx.userId);
    } catch (error) {
      handleServiceError(error);
    }
  }),
  /**
   * 課金情報を取得
   */
  getInfo: protectedProcedure
    .meta({ description: '課金情報取得（サブスクリプション状態）' })
    .query(async ({ ctx }) => {
      try {
        return await getBillingInfo(ctx.supabase, ctx.userId);
      } catch (error) {
        handleServiceError(error);
      }
    }),

  /**
   * 課金情報を一括取得（N+1 解消）
   * billingInfo + paymentMethod + invoices を1回の profiles SELECT で返す
   */
  getOverview: protectedProcedure
    .meta({ description: '課金情報一括取得（N+1解消、billingInfo+支払方法+請求書）' })
    .query(async ({ ctx }) => {
      try {
        return await getBillingOverview(ctx.supabase, ctx.userId);
      } catch (error) {
        handleServiceError(error);
      }
    }),

  /**
   * Stripe Checkout Session を作成し、URLを返す
   */
  createCheckoutSession: protectedProcedure
    .meta({ description: 'Stripe Checkoutセッション作成' })
    .input(billingOperationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        // ユーザーのメールを取得
        const {
          data: { user },
          error: authError,
        } = await observeAuthOperation('billing_checkout_get_user', () =>
          ctx.supabase.auth.getUser(),
        );

        if (authError) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            cause: authError,
          });
        }

        if (!user?.email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Email address is not set. Please check your profile settings.',
          });
        }

        const serviceRoleSupabase = createServiceRoleClient();
        const url = await createCheckoutSession(
          serviceRoleSupabase,
          ctx.userId,
          user.email,
          resolveBillingOperationId(input),
        );

        return { url };
      } catch (error) {
        handleServiceError(error);
      }
    }),

  /**
   * デフォルト支払い方法を取得
   */
  getPaymentMethod: protectedProcedure
    .meta({ description: 'デフォルト支払い方法取得' })
    .query(async ({ ctx }) => {
      try {
        return await getPaymentMethod(ctx.supabase, ctx.userId);
      } catch (error) {
        handleServiceError(error);
      }
    }),

  /**
   * 請求書一覧を取得
   */
  getInvoices: protectedProcedure.meta({ description: '請求書一覧取得' }).query(async ({ ctx }) => {
    try {
      return await getInvoices(ctx.supabase, ctx.userId);
    } catch (error) {
      handleServiceError(error);
    }
  }),

  /**
   * Stripe Customer Portal Session を作成し、URLを返す
   */
  createPortalSession: protectedProcedure
    .meta({ description: 'Stripe Customer Portalセッション作成' })
    .input(billingOperationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const serviceRoleSupabase = createServiceRoleClient();
        const url = await createPortalSession(
          serviceRoleSupabase,
          ctx.userId,
          resolveBillingOperationId(input),
        );
        return { url };
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
