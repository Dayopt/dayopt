import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { writeCronHeartbeat } from '@/lib/ops/cron-heartbeat';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import { dispatchExternalConnectionMaintenance } from './_composition/maintenance-dispatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TIME_BUDGET_MS = 50_000;
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

/**
 * Calendar revoke outbox と payload-free security event retention の集約 cron。
 *
 * response / logs は件数と滞留時間だけを返し、token、connection ID、user ID を含めない。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = env.CRON_SECRET?.trim();

  if (!cronSecret || cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    logger.warn('[external-connection-maintenance] CRON_SECRET is not configured');
    return noStoreJson({ error: 'Cron is not configured' }, 503);
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (!safeEquals(authorization, `Bearer ${cronSecret}`)) {
    return noStoreJson({ error: 'Unauthorized' }, 401);
  }

  if (await isWriteFenceEnabled(createServiceRoleClient())) {
    logger.warn('[external-connection-maintenance] write fence is enabled; skipping dispatch');
    return NextResponse.json(
      { error: 'Writes are temporarily paused for maintenance' },
      { status: 503, headers: { ...NO_STORE_HEADERS, 'retry-after': '900' } },
    );
  }

  const heartbeatStartedAt = new Date().toISOString();
  await writeCronHeartbeat('external-connection-maintenance', 'started', heartbeatStartedAt);
  try {
    const summary = await dispatchExternalConnectionMaintenance({
      deadlineAt: Date.now() + TIME_BUDGET_MS,
    });

    if (summary.outbox.revokeUnavailable) {
      logger.error('[external-connection-maintenance] revoke key is unavailable');
      return noStoreJson({ ok: false, error: 'Calendar revoke is unavailable', ...summary }, 503);
    }

    if (!summary.complete) {
      // どの区分が残っているかを添える。理由なしの warn だと OAuth retention の cleanup 失敗
      // (または単に backlog が batch size を超えている状態) と calendar outbox の滞留を
      // 区別できない。
      logger.warn('[external-connection-maintenance] work remains after dispatch', {
        retentionDue: summary.retention.due,
        outboxTotal: summary.outbox.total,
        outboxExpired: summary.outbox.expired,
        outboxRetried: summary.outbox.retried,
      });

      if (summary.outbox.expired > 0) {
        captureUnexpectedError(new Error('Calendar revoke expired before confirmation'), {
          feature: 'external_connection_maintenance',
          operation: 'revoke_expired',
          route: '/api/cron/external-connection-maintenance',
        });
      }
    }

    // #2055(a): finalize-calendar-revoke-guards cron 側の滞留は summary.complete の対象外
    // （この cron からは解消できない別 cron の backlog のため）。独立した warn 条件にする。
    if (summary.calendarFinalizeStuck > 0) {
      logger.warn('[external-connection-maintenance] finalize guard candidates are stuck', {
        calendarFinalizeStuck: summary.calendarFinalizeStuck,
      });
    }

    if (!summary.schemaUnavailable) {
      await writeCronHeartbeat('external-connection-maintenance', 'completed', heartbeatStartedAt);
    }
    return noStoreJson({ ok: true, ...summary });
  } catch {
    // dispatcher の将来変更でも raw DB/provider error を Sentry の cause へ通さない。
    captureUnexpectedError(new Error('External connection maintenance dispatch failed'), {
      feature: 'external_connection_maintenance',
      operation: 'cron_dispatch',
      route: '/api/cron/external-connection-maintenance',
    });
    logger.error('[external-connection-maintenance] dispatch failed');
    return noStoreJson({ error: 'Maintenance dispatch failed' }, 500);
  }
}
