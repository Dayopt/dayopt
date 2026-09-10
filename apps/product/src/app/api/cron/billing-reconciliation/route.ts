import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import {
  hasBillingWebhookReconciliationDiscrepancy,
  reconcileBillingWebhookEvents,
} from '@/features/settings/server';
import { logger } from '@/lib/logger';
import { captureUnexpectedError } from '@/lib/sentry';
import { parseStripeWebhookIdentity } from '@/lib/stripe/webhook-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIN_CRON_SECRET_LENGTH = 16;
const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/** Stripeとdurable webhook stateを日次照合する。検出専用でデータは変更しない。 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = env.CRON_SECRET?.trim();
  if (!cronSecret || cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    logger.warn('[billing-reconciliation] CRON_SECRET is not configured');
    return noStoreJson({ error: 'Cron is not configured' }, 503);
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (!safeEquals(authorization, `Bearer ${cronSecret}`)) {
    return noStoreJson({ error: 'Unauthorized' }, 401);
  }

  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const accountId = env.STRIPE_ACCOUNT_ID?.trim();
  const livemode = env.STRIPE_LIVEMODE;
  if (!secretKey && !accountId && !livemode) {
    return noStoreJson({ ok: true, configured: false });
  }

  const identity = parseStripeWebhookIdentity({ accountId, livemode });
  if (!secretKey || !identity) {
    logger.error('[billing-reconciliation] Stripe identity configuration is incomplete');
    captureUnexpectedError(new Error('Billing reconciliation is not configured'), {
      feature: 'billing',
      operation: 'billing_webhook_reconciliation_configuration',
      route: '/api/cron/billing-reconciliation',
      source: 'stripe_webhook',
    });
    return noStoreJson({ error: 'Billing reconciliation is not configured' }, 503);
  }

  try {
    const summary = await reconcileBillingWebhookEvents(identity);
    if (hasBillingWebhookReconciliationDiscrepancy(summary)) {
      logger.error('[billing-reconciliation] webhook discrepancies detected', summary);
      captureUnexpectedError(new Error('Billing webhook reconciliation discrepancy'), {
        feature: 'billing',
        operation: 'billing_webhook_reconciliation',
        route: '/api/cron/billing-reconciliation',
        source: 'stripe_webhook',
      });
      return noStoreJson({ ok: false, configured: true, ...summary }, 503);
    }

    return noStoreJson({ ok: true, configured: true, ...summary });
  } catch {
    logger.error('[billing-reconciliation] reconciliation failed');
    captureUnexpectedError(new Error('Billing webhook reconciliation failed'), {
      feature: 'billing',
      operation: 'billing_webhook_reconciliation',
      route: '/api/cron/billing-reconciliation',
      source: 'stripe_webhook',
    });
    return noStoreJson({ error: 'Billing reconciliation failed' }, 500);
  }
}
