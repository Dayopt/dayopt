import { isBillingEnforced } from '@/lib/billing/enforcement-flag';
import { dayoptProTrialDays } from '@dayopt/billing';
import 'server-only';

/**
 * Billing Service
 *
 * Stripe連携のビジネスロジック層。
 * Router → Service → Stripe/Supabase の3層構造に準拠。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { env } from '@/env';
import { getAppUrl } from '@/lib/app-url';
import { getBillingAccess } from '@/lib/billing/access-service';
import type { Database } from '@/lib/database';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { requireStripe } from '@/lib/stripe/client';
import { ServiceError } from '@/lib/trpc/errors';
import type { BillingAccess } from '@dayopt/billing';
import { type SubscriptionStatus } from '@dayopt/billing';

import { resolveBillingLifecycleMode } from './billing-lifecycle-mode';
import {
  createCheckoutSession as createDurableCheckoutSession,
  createPortalSession as createDurablePortalSession,
} from './billing-mutation-service';

// ===== Types =====

/** ユーザーの課金情報（サブスクリプション状態・Stripe ID） */
export interface BillingInfo {
  subscriptionStatus: SubscriptionStatus;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
}

/** クレジットカード支払い方法の概要情報 */
export interface PaymentMethod {
  brand: string; // visa, mastercard, amex, etc.
  last4: string;
  expMonth: number;
  expYear: number;
}

/** 請求書の概要情報（一覧表示用） */
export interface InvoiceItem {
  id: string;
  date: string; // ISO 8601
  amount: number; // cents
  currency: string;
  status: string;
  hostedInvoiceUrl: string | null;
}

type DeletedSubscriptionSyncResult =
  'account_deleted' | 'account_deleting' | 'already_terminal' | 'stale_subscription' | 'updated';
type BillingCustomerEventClassification = 'account_deleted' | 'live';

// ===== Error Codes =====

/** 課金サービス固有のエラークラス */
export class BillingServiceError extends ServiceError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message);
    this.name = 'BillingServiceError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

function getConfiguredProPriceId(): string {
  const priceId = env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID?.trim();

  if (!priceId?.startsWith('price_')) {
    throw new BillingServiceError(
      'STRIPE_PRICE_NOT_CONFIGURED',
      'Stripe Pro price is not configured',
    );
  }

  return priceId;
}

// ===== Service =====

/**
 * ユーザーの課金情報を取得
 */
export async function getBillingInfo(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<BillingInfo> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();

  if (error) {
    logger.error('Failed to fetch billing info');
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'get_billing_info',
    });
    throw new BillingServiceError('FETCH_FAILED', 'Failed to fetch billing info', {
      cause: original,
    });
  }

  // profiles型にはstripe系カラムが未反映のため Record 経由で取得
  const profile = data as Record<string, unknown>;

  return {
    subscriptionStatus: (profile.subscription_status as SubscriptionStatus) ?? 'free',
    stripeCustomerId: (profile.stripe_customer_id as string) ?? null,
    subscriptionId: (profile.subscription_id as string) ?? null,
  };
}

async function getOrCreateLegacyCustomer(
  stripe: Stripe,
  supabase: SupabaseClient<Database>,
  userId: string,
  email: string,
  operationId: string,
): Promise<string> {
  const { data, error: profileError } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();

  if (profileError) {
    const original = captureUnexpectedDatabaseError(profileError, {
      feature: 'billing',
      operation: 'get_legacy_stripe_customer',
    });
    throw new BillingServiceError('FETCH_FAILED', 'Failed to fetch Stripe customer', {
      cause: original,
    });
  }

  if (data.stripe_customer_id) return data.stripe_customer_id;

  const customer = await stripe.customers.create(
    {
      email,
      metadata: { supabase_user_id: userId },
    },
    { idempotencyKey: `dayopt-billing-customer-legacy-v1-${operationId}` },
  );

  const { error } = await supabase
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId);

  if (error) {
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'save_legacy_stripe_customer',
    });
    throw new BillingServiceError('UPDATE_FAILED', 'Failed to save Stripe customer', {
      cause: original,
    });
  }

  return customer.id;
}

async function createLegacyCheckoutSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  email: string,
  operationId: string,
): Promise<string> {
  const stripe = requireStripe();
  const priceId = getConfiguredProPriceId();
  const customerId = await getOrCreateLegacyCustomer(stripe, supabase, userId, email, operationId);
  const existingSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: 'all',
  });
  const appUrl = getAppUrl();
  const session = await stripe.checkout.sessions.create(
    {
      cancel_url: `${appUrl}/settings/billing?canceled=true`,
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { supabase_user_id: userId },
      mode: 'subscription',
      ...(isBillingEnforced() ? { payment_method_types: ['card' as const] } : {}),
      subscription_data:
        existingSubscriptions.data.length > 0 || isBillingEnforced()
          ? {}
          : { trial_period_days: dayoptProTrialDays },
      success_url: `${appUrl}/settings/billing?success=true`,
    },
    { idempotencyKey: `dayopt-billing-checkout-legacy-v1-${operationId}` },
  );

  if (!session.url) {
    throw new BillingServiceError('CREATE_FAILED', 'Failed to create checkout session');
  }
  return session.url;
}

async function createLegacyPortalSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  operationId: string,
): Promise<string> {
  const stripe = requireStripe();
  const billingInfo = await getBillingInfo(supabase, userId);
  if (!billingInfo.stripeCustomerId) {
    throw new BillingServiceError('NOT_FOUND', 'No Stripe customer found. Subscribe to Pro first.');
  }

  const session = await stripe.billingPortal.sessions.create(
    {
      customer: billingInfo.stripeCustomerId,
      return_url: `${getAppUrl()}/settings/billing?portal_return=true`,
    },
    { idempotencyKey: `dayopt-billing-portal-legacy-v1-${operationId}` },
  );
  return session.url;
}

export async function createCheckoutSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  email: string,
  operationId: string,
): Promise<string> {
  const lifecycleMode = await resolveBillingLifecycleMode(supabase);
  return lifecycleMode === 'durable'
    ? createDurableCheckoutSession(supabase, userId, email, operationId)
    : createLegacyCheckoutSession(supabase, userId, email, operationId);
}

export async function createPortalSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  operationId: string,
): Promise<string> {
  const lifecycleMode = await resolveBillingLifecycleMode(supabase);
  return lifecycleMode === 'durable'
    ? createDurablePortalSession(supabase, userId, operationId)
    : createLegacyPortalSession(supabase, userId, operationId);
}

/**
 * デフォルト支払い方法を取得
 */
export async function getPaymentMethod(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<PaymentMethod | null> {
  const stripe = requireStripe();
  const billingInfo = await getBillingInfo(supabase, userId);

  if (!billingInfo.stripeCustomerId) {
    return null;
  }

  const customer = await stripe.customers.retrieve(billingInfo.stripeCustomerId);

  if (customer.deleted) {
    return null;
  }

  const defaultPaymentMethodId =
    typeof customer.invoice_settings?.default_payment_method === 'string'
      ? customer.invoice_settings.default_payment_method
      : customer.invoice_settings?.default_payment_method?.id;

  if (!defaultPaymentMethodId) {
    return null;
  }

  const pm = await stripe.paymentMethods.retrieve(defaultPaymentMethodId);

  if (!pm.card) {
    return null;
  }

  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

/**
 * 請求書一覧を取得（最新10件）
 */
export async function getInvoices(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<InvoiceItem[]> {
  const stripe = requireStripe();
  const billingInfo = await getBillingInfo(supabase, userId);

  if (!billingInfo.stripeCustomerId) {
    return [];
  }

  const invoices = await stripe.invoices.list({
    customer: billingInfo.stripeCustomerId,
    limit: 10,
  });

  return invoices.data.map((inv) => ({
    id: inv.id,
    date: new Date((inv.created ?? 0) * 1000).toISOString(),
    amount: inv.amount_paid ?? 0,
    currency: inv.currency ?? 'usd',
    status: inv.status ?? 'unknown',
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  }));
}

// ===== Overview (統合エンドポイント) =====

/** 課金情報の一括取得結果（billingInfo・支払い方法・請求書を含む） */
export interface BillingOverview {
  access: BillingAccess;
  billingInfo: BillingInfo;
  paymentMethod: PaymentMethod | null;
  invoices: InvoiceItem[];
  /**
   * 試用期間の終了時刻（ISO 8601）。`trialing` 以外、subscription 未取得、
   * Stripe 側の取得失敗ではすべて null になる。
   */
  trialEndsAt: string | null;
}

/**
 * 課金情報を一括取得（N+1 解消）
 *
 * getBillingInfo + getPaymentMethod + getInvoices を1回の profiles SELECT で処理する。
 */
export async function getBillingOverview(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<BillingOverview> {
  // 1回だけ profiles を取得
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();

  if (error) {
    logger.error('Failed to fetch billing info');
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'get_billing_overview',
    });
    throw new BillingServiceError('FETCH_FAILED', 'Failed to fetch billing info', {
      cause: original,
    });
  }

  const profile = data as Record<string, unknown>;

  const billingInfo: BillingInfo = {
    subscriptionStatus: (profile.subscription_status as SubscriptionStatus) ?? 'free',
    stripeCustomerId: (profile.stripe_customer_id as string) ?? null,
    subscriptionId: (profile.subscription_id as string) ?? null,
  };

  const access = await getBillingAccess(supabase, userId);

  // Free ユーザーは Stripe 問い合わせ不要
  if (!billingInfo.stripeCustomerId) {
    return {
      billingInfo,
      access,
      paymentMethod: null,
      invoices: [],
      trialEndsAt: access.trialEndsAt,
    };
  }

  const stripe = requireStripe();

  // Stripe API を並列実行
  const [paymentMethod, invoiceList, trialEndsAt] = await Promise.all([
    getPaymentMethodByCustomerId(stripe, billingInfo.stripeCustomerId),
    getInvoicesByCustomerId(stripe, billingInfo.stripeCustomerId),
    getTrialEndsAt(stripe, billingInfo),
  ]);

  return {
    billingInfo,
    access,
    paymentMethod,
    invoices: invoiceList,
    trialEndsAt: access.state === 'trial' ? access.trialEndsAt : trialEndsAt,
  };
}

/**
 * 試用期間の終了時刻を Stripe から取得する（内部用）。
 *
 * **この関数は決して reject しない。** 呼び出し元の `Promise.all` は支払い方法・請求書の
 * 取得と束ねられており、ここで throw すると「試用期限という付加情報」のために
 * 支払い方法・請求書という既存の表示ごと落ちる。試用期限が出ないのは許容できるが、
 * Billing 画面が丸ごと壊れるのは許容できないので、失敗は null に畳む。
 *
 * 失敗しうる実例: subscription が既に削除されている、Stripe の一時的エラー、
 * `subscription_status` が profiles 側だけ trialing のまま残っている不整合。
 */
async function getTrialEndsAt(stripe: Stripe, billingInfo: BillingInfo): Promise<string | null> {
  if (billingInfo.subscriptionStatus !== 'trialing') return null;
  if (!billingInfo.subscriptionId) return null;

  try {
    const subscription = await stripe.subscriptions.retrieve(billingInfo.subscriptionId);
    // trial_end は unix 秒。trialing でも null になりうる（trial 無しで作られた場合）
    return subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
  } catch (error) {
    logger.error('Failed to fetch trial end from Stripe', {
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Stripe Customer ID から支払い方法を取得（内部用）
 */
async function getPaymentMethodByCustomerId(
  stripe: Stripe,
  customerId: string,
): Promise<PaymentMethod | null> {
  const customer = await stripe.customers.retrieve(customerId);

  if (customer.deleted) {
    return null;
  }

  const defaultPaymentMethodId =
    typeof customer.invoice_settings?.default_payment_method === 'string'
      ? customer.invoice_settings.default_payment_method
      : customer.invoice_settings?.default_payment_method?.id;

  if (!defaultPaymentMethodId) {
    return null;
  }

  const pm = await stripe.paymentMethods.retrieve(defaultPaymentMethodId);

  if (!pm.card) {
    return null;
  }

  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

/**
 * Stripe Customer ID から請求書一覧を取得（内部用）
 */
async function getInvoicesByCustomerId(stripe: Stripe, customerId: string): Promise<InvoiceItem[]> {
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: 10,
  });

  return invoices.data.map((inv) => ({
    id: inv.id,
    date: new Date((inv.created ?? 0) * 1000).toISOString(),
    amount: inv.amount_paid ?? 0,
    currency: inv.currency ?? 'usd',
    status: inv.status ?? 'unknown',
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  }));
}

/**
 * Webhook: サブスクリプションステータスを同期
 *
 * createServiceRoleClient() 経由の supabase を使用すること（RLSバイパス）
 */
export async function syncSubscriptionStatus(
  supabase: SupabaseClient<Database>,
  stripeCustomerId: string,
  subscriptionId: string | null,
  status: SubscriptionStatus,
): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .update({
      subscription_status: status,
      subscription_id: subscriptionId,
    })
    .eq('stripe_customer_id', stripeCustomerId)
    .select('id');

  if (error) {
    logger.error('Failed to sync subscription status', { status });
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'sync_subscription_status',
    });
    throw new BillingServiceError('UPDATE_FAILED', 'Failed to sync subscription status', {
      cause: original,
    });
  }

  const rowsUpdated = data?.length ?? 0;

  if (rowsUpdated === 0) {
    throw new BillingServiceError(
      'UPDATE_FAILED',
      'No billing profile was updated for the Stripe customer',
      {
        cause: new Error('Stripe subscription sync updated zero profiles'),
      },
    );
  }

  logger.info('Subscription status synced', { status, rowsUpdated });
}

/**
 * Webhook: subscription.deleted を現在のsubscriptionへだけ反映する。
 *
 * Auth削除と同時transactionで残した短期receiptがある場合だけ、profile消滅後の
 * terminal eventを成功として扱う。未知Customerはlive data driftを隠さないため失敗する。
 */
export async function syncDeletedSubscriptionStatus(
  supabase: SupabaseClient<Database>,
  stripeCustomerId: string,
  subscriptionId: string,
): Promise<DeletedSubscriptionSyncResult> {
  const { data, error } = await supabase.rpc('sync_billing_subscription_deleted_v1', {
    p_stripe_customer_id: stripeCustomerId,
    p_subscription_id: subscriptionId,
  });

  if (error) {
    logger.error('Failed to sync deleted subscription');
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'sync_deleted_subscription_status',
    });
    throw new BillingServiceError('UPDATE_FAILED', 'Failed to sync deleted subscription', {
      cause: original,
    });
  }

  if (
    data === 'updated' ||
    data === 'account_deleting' ||
    data === 'already_terminal' ||
    data === 'stale_subscription' ||
    data === 'account_deleted'
  ) {
    logger.info('Deleted subscription synchronized', { outcome: data });
    return data;
  }

  throw new BillingServiceError(
    'UPDATE_FAILED',
    'No live or deleted billing account matched the Stripe subscription',
    {
      cause: new Error('Stripe subscription deletion matched no billing terminal state'),
    },
  );
}

export async function classifyBillingCustomerEvent(
  supabase: SupabaseClient<Database>,
  stripeCustomerId: string,
): Promise<BillingCustomerEventClassification> {
  const { data, error } = await supabase.rpc('classify_billing_customer_event_v1', {
    p_stripe_customer_id: stripeCustomerId,
  });

  if (error) {
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'billing',
      operation: 'classify_customer_event',
    });
    throw new BillingServiceError('FETCH_FAILED', 'Failed to classify billing customer event', {
      cause: original,
    });
  }
  if (data === 'live' || data === 'account_deleted') return data;

  throw new BillingServiceError('FETCH_FAILED', 'Stripe event Customer is unknown', {
    cause: new Error('Stripe Customer matched no live or terminal billing state'),
  });
}
