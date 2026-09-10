/**
 * Stripe Webhook エンドポイント
 *
 * Stripe Dashboard → Webhooks でこのURLを登録:
 *   dayoptUrls.marketing + /api/webhooks/stripe
 *
 * 監視イベント:
 * - checkout.session.completed: チェックアウト完了
 * - customer.subscription.updated: サブスクリプション更新
 * - customer.subscription.deleted: サブスクリプション削除
 *
 * @see https://docs.stripe.com/webhooks
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';

export const maxDuration = 30;

import { Resend } from 'resend';

import { CancellationConfirmEmail } from '@/emails/CancellationConfirmEmail';
import { createEmailTranslator, type EmailLocale } from '@/emails/i18n';
import { PaymentFailedEmail } from '@/emails/PaymentFailedEmail';
import { PaymentRecoveredEmail } from '@/emails/PaymentRecoveredEmail';
import { ProStartEmail } from '@/emails/ProStartEmail';
import { TrialStartEmail } from '@/emails/TrialStartEmail';
import { env } from '@/env';
import { resolveBillingLifecycleMode } from '@/features/settings/server/billing-lifecycle-mode';
import {
  classifyBillingCustomerEvent,
  syncDeletedSubscriptionStatus,
  syncSubscriptionStatus,
} from '@/features/settings/server/billing-service';
import { trackBillingEvent } from '@/lib/analytics/billing-events';
import { trackProductEvent } from '@/lib/analytics/product-events';
import { getAppUrl } from '@/lib/app-url';
import { logger } from '@/lib/logger';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import {
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
  observeAuthOperation,
} from '@/lib/sentry';
import { requireStripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { getOriginalError } from '@/lib/trpc/errors';
import { captureWebhookSignatureFailure } from '@/lib/webhooks/signature-failure-monitor';
import { mapStripeSubscriptionStatus } from '@dayopt/billing';

import {
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
} from './stripe-webhook-idempotency';
import { parseStripeWebhookIdentity, verifyStripeWebhookIdentity } from './stripe-webhook-identity';

// ─── トランザクションメール送信 ─────────────────────────

const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const APP_URL = getAppUrl();

function captureStripeWebhookFailure(
  error: unknown,
  operation: string,
  event?: { id: string; type: string },
): Error {
  const normalized =
    error instanceof Error
      ? error
      : new Error('Unknown Stripe webhook processing error', { cause: error });
  // Service errors may wrap an already-captured database failure. Always use
  // the deepest Error so capture-once de-duplicates on the original instance.
  const original = getOriginalError(normalized);
  captureUnexpectedError(original, {
    feature: 'billing',
    source: 'stripe_webhook',
    operation,
    route: '/api/webhooks/stripe',
    ...(event ? { requestId: event.id } : {}),
  });
  return original;
}

interface BillingProfileIdentity {
  id: string;
  fullName: string | null;
}

/** Resolve the trusted application user independently from transactional email delivery. */
async function getBillingProfileByCustomerId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  stripeCustomerId: string,
): Promise<BillingProfileIdentity | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (error || !data) {
    logger.warn('Failed to look up billing profile');
    if (error) {
      captureUnexpectedDatabaseError(error, {
        feature: 'billing',
        operation: 'lookup_billing_profile',
        route: '/api/webhooks/stripe',
        source: 'supabase_database',
      });
    }
    return null;
  }

  return { id: data.id, fullName: data.full_name };
}

async function getTransactionalEmailUser(
  supabase: ReturnType<typeof createServiceRoleClient>,
  profile: BillingProfileIdentity,
): Promise<{ email: string; userName: string; locale: EmailLocale } | null> {
  // Supabase Auth からメールアドレスを取得
  const {
    data: { user },
    error: authError,
  } = await observeAuthOperation('stripe_webhook_get_user_by_id', () =>
    supabase.auth.admin.getUserById(profile.id),
  );

  if (authError || !user?.email) {
    logger.warn('Failed to get user email for transactional email');
    return null;
  }

  // user_settings から preferred_locale を取得
  const { data: settingsData, error: settingsError } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', profile.id)
    .maybeSingle();
  if (settingsError) {
    captureUnexpectedDatabaseError(settingsError, {
      feature: 'billing',
      operation: 'lookup_transactional_email_locale',
      route: '/api/webhooks/stripe',
      source: 'supabase_database',
    });
  }
  const rawLocale = (settingsData as Record<string, unknown> | null)?.preferred_locale;
  const locale: EmailLocale = (rawLocale as EmailLocale) ?? 'en';

  return { email: user.email, userName: profile.fullName || 'there', locale };
}

/** stripe_customer_id からトランザクションメール宛先を取得する。 */
async function getUserByCustomerId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  stripeCustomerId: string,
): Promise<{ email: string; userName: string; locale: EmailLocale } | null> {
  const profile = await getBillingProfileByCustomerId(supabase, stripeCustomerId);
  return profile ? getTransactionalEmailUser(supabase, profile) : null;
}

/**
 * トランザクションメール送信（fire-and-forget）
 * メール送信失敗は webhook 処理をブロックしない
 */
async function sendTransactionalEmail(
  to: string,
  subject: string,
  react: React.ReactElement,
  operation: string,
): Promise<void> {
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: `Dayopt <${FROM_EMAIL}>`,
      to,
      subject,
      react,
    });

    if (error) {
      logger.error('Transactional email delivery failed');
      captureStripeWebhookFailure(error, operation);
    } else {
      logger.info('Transactional email sent', { operation });
    }
  } catch (error) {
    logger.error('Transactional email delivery failed unexpectedly');
    captureStripeWebhookFailure(error, operation);
  }
}

export async function POST(request: NextRequest) {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET is not configured');
    captureStripeWebhookFailure(
      new Error('Stripe webhook secret is not configured'),
      'configuration',
    );
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  let stripe: ReturnType<typeof requireStripe>;
  try {
    stripe = requireStripe();
  } catch (error) {
    logger.error('Stripe is not configured');
    captureStripeWebhookFailure(error, 'configuration');
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    logger.warn('Stripe webhook missing signature header');
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  let payload: string;
  try {
    payload = await request.text();
  } catch (error) {
    logger.error('Stripe webhook body could not be read');
    captureStripeWebhookFailure(error, 'read_request_body');
    return NextResponse.json({ error: 'Webhook body unavailable' }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    logger.warn('Stripe webhook signature verification failed');
    captureWebhookSignatureFailure({
      feature: 'billing',
      route: '/api/webhooks/stripe',
      source: 'stripe_webhook',
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // RLS バイパスの admin client（webhook はユーザーコンテキストなし）
  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch (error) {
    logger.error('Stripe webhook database client is not configured');
    captureStripeWebhookFailure(error, 'create_database_client', event);
    return NextResponse.json({ error: 'Webhook processing unavailable' }, { status: 500 });
  }

  // claim（冪等性の予約）より前に確認する。claim 後に 503 を返すと予約が滞留したまま
  // 残り、Stripe の再送が「処理中」で弾かれ続ける。
  if (await isWriteFenceEnabled(supabase)) {
    logger.warn('Stripe webhook rejected: write fence is enabled');
    return NextResponse.json(
      { error: 'Webhook processing is temporarily paused for maintenance' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }

  let lifecycleMode: 'durable' | 'legacy';
  try {
    lifecycleMode = await resolveBillingLifecycleMode(supabase);
  } catch (error) {
    logger.error('Stripe webhook lifecycle activation could not be verified');
    captureStripeWebhookFailure(error, 'lifecycle_activation', event);
    return NextResponse.json({ error: 'Webhook processing unavailable' }, { status: 500 });
  }

  if (lifecycleMode === 'durable') {
    const expectedIdentity = parseStripeWebhookIdentity({
      accountId: env.STRIPE_ACCOUNT_ID,
      livemode: env.STRIPE_LIVEMODE,
    });
    if (expectedIdentity === null) {
      logger.error('Stripe webhook identity is not configured');
      captureStripeWebhookFailure(
        new Error('Stripe webhook identity is not configured'),
        'identity',
      );
      return NextResponse.json({ error: 'Webhook identity not configured' }, { status: 500 });
    }
    let providerEvent: Stripe.Event | null = null;
    try {
      providerEvent = await verifyStripeWebhookIdentity(stripe, event, expectedIdentity);
    } catch (error) {
      logger.error('Stripe webhook identity verification failed');
      captureStripeWebhookFailure(error, 'identity_provider_verification', event);
      return NextResponse.json({ error: 'Webhook identity unavailable' }, { status: 500 });
    }
    if (providerEvent === null) {
      logger.error('Stripe webhook identity mismatch');
      captureStripeWebhookFailure(new Error('Stripe webhook identity mismatch'), 'identity', event);
      return NextResponse.json({ error: 'Webhook identity mismatch' }, { status: 500 });
    }
    // durable有効化後は署名payloadをidentity確認だけに使い、業務入力をprovider Eventへ固定する。
    event = providerEvent;
  }

  // ─── 冪等性ガード ───────────────────────────────────
  // 同一 event.id の重複処理を防止（Stripe はリトライする）
  try {
    const claim = await claimStripeWebhookEvent(supabase, event);
    if (claim === 'already_processed') {
      logger.info('Duplicate webhook event, skipping', { eventId: event.id });
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }
    if (claim === 'in_progress') {
      logger.warn('Stripe webhook event is already being processed');
      return NextResponse.json(
        { error: 'Webhook processing in progress' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
  } catch (error) {
    logger.error('Stripe webhook idempotency claim failed');
    captureStripeWebhookFailure(error, 'claim', event);
    return NextResponse.json({ error: 'Webhook processing unavailable' }, { status: 500 });
  }

  let subscriptionStartedUserId: string | null = null;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.mode === 'subscription' && session.subscription && session.customer) {
          const customerId =
            typeof session.customer === 'string' ? session.customer : session.customer.id;
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id;

          // 実際の subscription ステータスを取得（trialing vs active）
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const status = mapStripeSubscriptionStatus(sub.status);

          await syncSubscriptionStatus(supabase, customerId, subscriptionId, status);
          logger.info('Checkout completed', { customerId, subscriptionId, status });

          const profile = await getBillingProfileByCustomerId(supabase, customerId);
          subscriptionStartedUserId = profile?.id ?? null;

          // トランザクションメール送信
          const user = profile ? await getTransactionalEmailUser(supabase, profile) : null;
          if (user) {
            const t = createEmailTranslator(user.locale);
            if (status === 'trialing') {
              const trialEnd = sub.trial_end
                ? new Date(sub.trial_end * 1000).toLocaleDateString(
                    user.locale === 'ja' ? 'ja-JP' : 'en-US',
                    { year: 'numeric', month: 'long', day: 'numeric' },
                  )
                : '7 days from now';
              await sendTransactionalEmail(
                user.email,
                t('trialStart.subject'),
                TrialStartEmail({
                  userName: user.userName,
                  trialEndDate: trialEnd,
                  locale: user.locale,
                  appUrl: APP_URL,
                }),
                'send_trial_start_email',
              );
            } else if (status === 'active') {
              await sendTransactionalEmail(
                user.email,
                t('proStart.subject'),
                ProStartEmail({ userName: user.userName, locale: user.locale, appUrl: APP_URL }),
                'send_pro_start_email',
              );
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id;

        const status = mapStripeSubscriptionStatus(subscription.status);
        const previousStatus = event.data.previous_attributes
          ? mapStripeSubscriptionStatus(
              (event.data.previous_attributes as { status?: Stripe.Subscription.Status }).status ??
                subscription.status,
            )
          : null;

        await syncSubscriptionStatus(supabase, customerId, subscription.id, status);
        logger.info('Subscription updated', {
          customerId,
          subscriptionId: subscription.id,
          status,
          previousStatus,
        });

        // trialing → active: Pro開始メール
        if (previousStatus === 'trialing' && status === 'active') {
          const updatedUser = await getUserByCustomerId(supabase, customerId);
          if (updatedUser) {
            const t = createEmailTranslator(updatedUser.locale);
            await sendTransactionalEmail(
              updatedUser.email,
              t('proStart.subject'),
              ProStartEmail({
                userName: updatedUser.userName,
                locale: updatedUser.locale,
                appUrl: APP_URL,
              }),
              'send_trial_conversion_email',
            );
          }
        }

        // past_due → active: 支払い復旧メール
        if (previousStatus === 'past_due' && status === 'active') {
          const recoveredUser = await getUserByCustomerId(supabase, customerId);
          if (recoveredUser) {
            const t = createEmailTranslator(recoveredUser.locale);
            await sendTransactionalEmail(
              recoveredUser.email,
              t('paymentRecovered.subject'),
              PaymentRecoveredEmail({
                userName: recoveredUser.userName,
                locale: recoveredUser.locale,
                appUrl: APP_URL,
              }),
              'send_payment_recovered_email',
            );
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id;

        let syncOutcome: Awaited<ReturnType<typeof syncDeletedSubscriptionStatus>>;
        if (lifecycleMode === 'durable') {
          syncOutcome = await syncDeletedSubscriptionStatus(supabase, customerId, subscription.id);
        } else {
          await syncSubscriptionStatus(supabase, customerId, null, 'canceled');
          syncOutcome = 'updated';
        }
        logger.info('Subscription deleted', { outcome: syncOutcome });

        if (syncOutcome === 'updated' || syncOutcome === 'already_terminal') {
          const endedProfile = await getBillingProfileByCustomerId(supabase, customerId);
          if (
            endedProfile &&
            !(await trackBillingEvent({
              eventName: 'subscription_ended',
              sourceId: subscription.id,
              userId: endedProfile.id,
              occurredAt: new Date(event.created * 1_000).toISOString(),
            }))
          )
            throw new Error('Billing analytics must be retried');
        }
        if (syncOutcome === 'updated') {
          // 解約確認メール
          const cancelUser = await getUserByCustomerId(supabase, customerId);
          if (cancelUser) {
            const t = createEmailTranslator(cancelUser.locale);
            const rawPeriodEnd = (subscription as unknown as { current_period_end?: number })
              .current_period_end;
            const periodEnd = rawPeriodEnd
              ? new Date(rawPeriodEnd * 1000).toLocaleDateString(
                  cancelUser.locale === 'ja' ? 'ja-JP' : 'en-US',
                  { year: 'numeric', month: 'long', day: 'numeric' },
                )
              : 'your current billing period';
            await sendTransactionalEmail(
              cancelUser.email,
              t('cancellationConfirm.subject'),
              CancellationConfirmEmail({
                userName: cancelUser.userName,
                periodEndDate: periodEnd,
                locale: cancelUser.locale,
                appUrl: APP_URL,
              }),
              'send_cancellation_email',
            );
          }
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (
          customerId &&
          invoice.status === 'paid' &&
          invoice.amount_paid > 0 &&
          (invoice.billing_reason === 'subscription_create' ||
            invoice.billing_reason === 'subscription_cycle')
        ) {
          if (
            lifecycleMode === 'durable' &&
            (await classifyBillingCustomerEvent(supabase, customerId)) === 'account_deleted'
          )
            break;
          const user = await getBillingProfileByCustomerId(supabase, customerId);
          if (!user) throw new Error('Paid invoice has no application user');
          const { error: consumptionError } = await supabase
            .from('profiles')
            .update({ app_trial_consumed_at: new Date(event.created * 1_000).toISOString() })
            .eq('id', user.id)
            .is('app_trial_consumed_at', null);
          if (consumptionError)
            throw captureUnexpectedDatabaseError(consumptionError, {
              feature: 'billing',
              operation: 'consume_paid_trial',
            });

          if (
            !(await trackBillingEvent({
              eventName:
                invoice.billing_reason === 'subscription_create'
                  ? 'subscription_payment_succeeded'
                  : 'subscription_renewal_succeeded',
              sourceId: invoice.id,
              userId: user.id,
              occurredAt: new Date(event.created * 1_000).toISOString(),
            }))
          )
            throw new Error('Billing analytics must be retried');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (!customerId && lifecycleMode === 'durable') {
          throw new Error('Stripe invoice event has no Customer identity');
        }
        if (customerId && lifecycleMode === 'durable') {
          const classification = await classifyBillingCustomerEvent(supabase, customerId);
          if (classification === 'account_deleted') {
            logger.info('Payment failure ignored for deleted account');
            break;
          }
        }
        logger.warn('Payment failed', { customerId });

        // 支払い失敗メール
        const paymentUser = customerId ? await getUserByCustomerId(supabase, customerId) : null;
        if (!paymentUser && lifecycleMode === 'durable') {
          throw new Error('Live Stripe Customer has no application user');
        }
        if (paymentUser) {
          const t = createEmailTranslator(paymentUser.locale);
          await sendTransactionalEmail(
            paymentUser.email,
            t('paymentFailed.subject'),
            PaymentFailedEmail({
              userName: paymentUser.userName,
              locale: paymentUser.locale,
              appUrl: APP_URL,
            }),
            'send_payment_failed_email',
          );
        }
        break;
      }

      default:
        if (lifecycleMode === 'durable') {
          throw new Error('Unsupported Stripe webhook event');
        }
        logger.info('Stripe webhook event (unhandled)', { type: event.type });
    }

    await markStripeWebhookEventProcessed(supabase, event.id);
    if (subscriptionStartedUserId) {
      await trackProductEvent({
        eventName: 'subscription_started',
        userId: subscriptionStartedUserId,
      });
    }
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    // 元障害を先にcaptureし、cleanup失敗がstackを隠さないようにする。
    const unexpectedError = captureStripeWebhookFailure(
      error,
      `stripe_webhook.${event.type}`,
      event,
    );
    // 処理失敗時は予約を解放し、Stripeのretryを受け入れる。解放失敗はhelper内で別途captureする。
    await releaseStripeWebhookEvent(supabase, event.id);

    logger.error('Stripe webhook processing error', {
      errorType: unexpectedError.name,
      eventType: event.type,
    });
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
