/**
 * Product-owned Resend webhook.
 *
 * The app-specific signing secret, source tag, and atomic claim lease keep Product
 * delivery events isolated and idempotent while preserving transactional-email
 * suppression behavior.
 */

import { dayoptContact, dayoptContactDeliverySources } from '@dayopt/config';
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import {
  claimSupabaseWebhookEventPoc,
  completeSupabaseWebhookEventPoc,
  isSupabaseWebhookClaimPocEnabled,
  releaseSupabaseWebhookEventPoc,
  type SupabaseRateLimitPocClient,
} from '@/lib/rate-limit/supabase-poc';
import {
  claimResendWebhookEvent as claimResendWebhookEventWithUpstash,
  completeResendWebhookEvent as completeResendWebhookEventWithUpstash,
  hashRateLimitIdentifier,
  releaseResendWebhookEvent as releaseResendWebhookEventWithUpstash,
} from '@/lib/rate-limit/upstash';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { captureWebhookSignatureFailure } from '@/lib/webhooks/signature-failure-monitor';

export const maxDuration = 30;
export const runtime = 'nodejs';

function getResend() {
  return new Resend(env.RESEND_API_KEY);
}

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

class WebhookBodyTooLargeError extends Error {}

class SuppressionWriteError extends Error {
  constructor(
    public readonly sourceEventId: string | undefined,
    cause: unknown,
  ) {
    super('Failed to record email suppression', { cause });
    this.name = 'SuppressionWriteError';
  }
}

type ClaimedWebhookEvent =
  | { backend: 'upstash'; eventId: string; token: string }
  | {
      backend: 'supabase-with-upstash-compatibility';
      eventId: string;
      upstashToken: string;
      eventHash: string;
      supabaseToken: string;
    };

type WebhookClaimResult =
  | { status: 'claimed'; claim: ClaimedWebhookEvent }
  | { status: 'already_processed' }
  | { status: 'in_progress' };

type EmailEventData = {
  email_id: string;
  to: string[];
  tags?: Record<string, string>;
  /** `email.bounced` だけが持つ。Resend SDK の `EmailBouncedEvent['data']['bounce']` と同形。 */
  bounce?: { type?: string; subType?: string; message?: string };
};

/**
 * suppression に書く bounce かどうか。
 *
 * Resend は `bounce.type` に `permanent` / `transient` / `undetermined` を載せる。
 * `email_suppressions` は書いたら消す経路が無い恒久リストなので、mailbox full や
 * greylisting のような transient を書くと、その address 宛の transactional mail
 * （password changed / MFA disabled / billing 通知）が永久に止まる。auth mail は
 * Edge Function が suppression を見ないため届き続け、利用者は気づけない。
 * transient だけを除外し、`undetermined` と欠落は配信評価を守る側（suppress）に倒す。
 */
function isSuppressibleBounce(data: EmailEventData): boolean {
  return data.bounce?.type?.toLowerCase() !== 'transient';
}

function isEmailEventData(data: unknown): data is EmailEventData {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Partial<EmailEventData>;
  return (
    typeof candidate.email_id === 'string' &&
    Array.isArray(candidate.to) &&
    candidate.to.every((address) => typeof address === 'string')
  );
}

function isContactDelivery(data: EmailEventData, source: string): boolean {
  return (
    data.to.some((address) => address.toLowerCase() === dayoptContact.supportEmail) &&
    data.tags?.source === source
  );
}

async function readWebhookBody(request: NextRequest): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new WebhookBodyTooLargeError();
    }
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let payload = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookBodyTooLargeError();
      }
      payload += decoder.decode(value, { stream: true });
    }
    return payload + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function captureContactDeliveryFailure(eventType: string, data: EmailEventData): void {
  logger.error('Contact email delivery failed', {
    eventType,
    emailId: data.email_id,
  });
  captureUnexpectedError(new Error(`Contact email delivery failed: ${eventType}`), {
    feature: 'contact',
    operation: 'email_delivery_status',
    route: '/api/webhooks/resend',
    source: 'resend_webhook',
    requestId: data.email_id,
  });
}

async function recordSuppression(
  addresses: string[],
  reason: 'bounce' | 'complaint',
  sourceEventId: string | undefined,
): Promise<void> {
  const supabase = createServiceRoleClient();

  for (const email of addresses) {
    const { error } = await supabase.from('email_suppressions').upsert(
      {
        email: email.toLowerCase(),
        reason,
        source_event_id: sourceEventId ?? null,
      },
      { onConflict: 'email,reason' },
    );

    if (error) {
      logger.error('Failed to record email suppression', { reason });
      throw new SuppressionWriteError(sourceEventId, error);
    }
    logger.info('Email suppression recorded', { reason });
  }
}

async function claimWebhookEvent(eventId: string): Promise<WebhookClaimResult> {
  if (!isSupabaseWebhookClaimPocEnabled()) {
    const claim = await claimResendWebhookEventWithUpstash(eventId);
    if (claim.status !== 'claimed') return claim;
    return { status: 'claimed', claim: { backend: 'upstash', eventId, token: claim.token } };
  }

  // Keep Upstash as a compatibility claim while old 35-day markers and old Vercel
  // deployments can still receive retries. New POC events are written to both stores.
  const upstashClaim = await claimResendWebhookEventWithUpstash(eventId);
  if (upstashClaim.status !== 'claimed') return upstashClaim;

  let eventHash: string | undefined;
  let client: SupabaseRateLimitPocClient | undefined;
  const supabaseToken = crypto.randomUUID();
  try {
    eventHash = await hashRateLimitIdentifier(`resend-event:${eventId}`);
    client = createServiceRoleClient() as unknown as SupabaseRateLimitPocClient;
    const status = await claimSupabaseWebhookEventPoc(client, eventHash, supabaseToken);
    if (status !== 'claimed') {
      await releaseResendWebhookEventWithUpstash(eventId, upstashClaim.token);
      return { status };
    }
    return {
      status,
      claim: {
        backend: 'supabase-with-upstash-compatibility',
        eventId,
        upstashToken: upstashClaim.token,
        eventHash,
        supabaseToken,
      },
    };
  } catch (error) {
    const releases: Promise<unknown>[] = [
      releaseResendWebhookEventWithUpstash(eventId, upstashClaim.token),
    ];
    if (client && eventHash) {
      releases.push(releaseSupabaseWebhookEventPoc(client, eventHash, supabaseToken));
    }
    const releaseResults = await Promise.allSettled(releases);
    if (releaseResults.some((result) => result.status === 'rejected')) {
      logger.error('Failed to release Resend webhook compatibility claim');
    }
    throw error;
  }
}

async function completeWebhookEvent(claim: ClaimedWebhookEvent): Promise<void> {
  if (claim.backend === 'supabase-with-upstash-compatibility') {
    const client = createServiceRoleClient() as unknown as SupabaseRateLimitPocClient;
    const completed = await completeSupabaseWebhookEventPoc(
      client,
      claim.eventHash,
      claim.supabaseToken,
    );
    if (!completed) throw new Error('Supabase webhook processing lease is no longer owned');
    await completeResendWebhookEventWithUpstash(claim.eventId, claim.upstashToken);
    return;
  }

  if (claim.backend === 'upstash') {
    await completeResendWebhookEventWithUpstash(claim.eventId, claim.token);
  }
}

async function releaseWebhookEvent(claim: ClaimedWebhookEvent): Promise<void> {
  if (claim.backend === 'supabase-with-upstash-compatibility') {
    const client = createServiceRoleClient() as unknown as SupabaseRateLimitPocClient;
    const results = await Promise.allSettled([
      releaseSupabaseWebhookEventPoc(client, claim.eventHash, claim.supabaseToken),
      releaseResendWebhookEventWithUpstash(claim.eventId, claim.upstashToken),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return;
  }

  if (claim.backend === 'upstash') {
    await releaseResendWebhookEventWithUpstash(claim.eventId, claim.token);
  }
}

export async function POST(request: NextRequest) {
  let claimedEvent: ClaimedWebhookEvent | undefined;
  let contactDeliveryFailure: { eventType: string; data: EmailEventData } | undefined;

  try {
    const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      logger.error('RESEND_WEBHOOK_SECRET is not configured');
      captureUnexpectedError(new Error('Resend webhook secret is not configured'), {
        feature: 'email',
        operation: 'resend_webhook_configuration',
        route: '/api/webhooks/resend',
        source: 'resend_webhook',
      });
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    const svixId = request.headers.get('svix-id');
    const svixTimestamp = request.headers.get('svix-timestamp');
    const svixSignature = request.headers.get('svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
      logger.warn('Resend webhook missing svix headers');
      return NextResponse.json({ error: 'Missing signature headers' }, { status: 401 });
    }

    let payload: string;
    try {
      payload = await readWebhookBody(request);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
      }
      throw error;
    }

    let event;
    try {
      event = getResend().webhooks.verify({
        payload,
        headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
        webhookSecret,
      });
    } catch {
      logger.warn('Resend webhook signature verification failed');
      captureWebhookSignatureFailure({
        feature: 'email',
        route: '/api/webhooks/resend',
        source: 'resend_webhook',
      });
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    if (
      isEmailEventData(event.data) &&
      isContactDelivery(event.data, dayoptContactDeliverySources.web)
    ) {
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // claim（Redis / Supabase lease）より前に確認する。claim 後に 503 を返すと lease が残ったまま
    // 残り、Resend の再送が「処理中」で弾かれ続ける。この分岐より前（署名検証だけで
    // 済む早期 return）には書き込みが無いので fence は不要 — むしろ手前で 503 にすると
    // 無意味な再送で Resend の backoff 予算を消費させてしまう。
    if (await isWriteFenceEnabled(createServiceRoleClient())) {
      logger.warn('Resend webhook rejected: write fence is enabled');
      return NextResponse.json(
        { error: 'Webhook processing is temporarily paused for maintenance' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }

    const claim = await claimWebhookEvent(svixId);
    if (claim.status === 'already_processed') {
      return NextResponse.json({ received: true }, { status: 200 });
    }
    if (claim.status === 'in_progress') {
      return NextResponse.json({ error: 'Webhook processing in progress' }, { status: 503 });
    }
    const activeClaim = claim.claim;
    claimedEvent = activeClaim;

    switch (event.type) {
      case 'email.bounced': {
        if (
          isEmailEventData(event.data) &&
          isContactDelivery(event.data, dayoptContactDeliverySources.product)
        ) {
          contactDeliveryFailure = { eventType: event.type, data: event.data };
          break;
        }
        if (isEmailEventData(event.data) && !isSuppressibleBounce(event.data)) {
          logger.warn('Transient email bounce ignored for suppression', {
            emailId: event.data.email_id,
            bounceType: event.data.bounce?.type,
          });
          break;
        }
        await recordSuppression(event.data.to, 'bounce', event.data.email_id);
        break;
      }

      case 'email.complained': {
        if (
          isEmailEventData(event.data) &&
          isContactDelivery(event.data, dayoptContactDeliverySources.product)
        ) {
          contactDeliveryFailure = { eventType: event.type, data: event.data };
          break;
        }
        await recordSuppression(event.data.to, 'complaint', event.data.email_id);
        break;
      }

      case 'email.delivered':
        logger.info('Email delivered', { emailId: event.data.email_id });
        break;

      case 'email.delivery_delayed':
        logger.warn('Email delivery delayed', { emailId: event.data.email_id });
        break;

      case 'email.failed':
      case 'email.suppressed':
        if (
          isEmailEventData(event.data) &&
          isContactDelivery(event.data, dayoptContactDeliverySources.product)
        ) {
          contactDeliveryFailure = { eventType: event.type, data: event.data };
        } else if (isEmailEventData(event.data)) {
          logger.error('Email delivery failed', {
            emailId: event.data.email_id,
            type: event.type,
          });
        }
        break;

      default:
        logger.info('Resend webhook event', { type: event.type });
    }

    await completeWebhookEvent(activeClaim);
    claimedEvent = undefined;
    // The terminal marker must win the race with the observable side effect.
    // Otherwise a marker failure followed by a provider retry creates a second
    // Sentry Issue for the same signed event.
    if (contactDeliveryFailure) {
      captureContactDeliveryFailure(contactDeliveryFailure.eventType, contactDeliveryFailure.data);
    }
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    logger.error('Resend webhook processing failed');
    const original = error instanceof Error ? error : new Error('Unknown Resend webhook failure');

    if (claimedEvent) {
      try {
        await releaseWebhookEvent(claimedEvent);
      } catch (releaseError) {
        logger.error('Failed to release Resend webhook event claim');
        captureUnexpectedError(
          releaseError instanceof Error ? releaseError : new Error('Webhook lease release failed'),
          {
            feature: 'email',
            operation: 'resend_webhook_lease_release',
            route: '/api/webhooks/resend',
            source: 'resend_webhook',
          },
        );
      }
    }

    if (original instanceof SuppressionWriteError) {
      captureUnexpectedDatabaseError(original.cause ?? original, {
        feature: 'email',
        operation: 'record_email_suppression',
        route: '/api/webhooks/resend',
        ...(original.sourceEventId ? { requestId: original.sourceEventId } : {}),
      });
    } else {
      captureUnexpectedError(original, {
        feature: 'email',
        operation: 'resend_webhook_processing',
        route: '/api/webhooks/resend',
        source: 'resend_webhook',
      });
    }
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
