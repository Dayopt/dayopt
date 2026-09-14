import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { writeCronHeartbeat } from '@/lib/ops/cron-heartbeat';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

import {
  CalendarAccountDeletionSettleError,
  dispatchCalendarAccountDeletionSettle,
} from './_composition/settle-dispatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// SETTLE_WORST_CASE_MS に対して、最大3sのheartbeat記録を含め7sのhard-kill marginを残す
// （他の cron route と同じ導出。route.test.ts が実測で固定する）。export するのは
// route.test.ts の予算不等式チェックがこの値をリテラル複製せず import するため
// （pr-cross-review 指摘。値がずれたまま test が両方 pass する事故を防ぐ）。
export const TIME_BUDGET_MS = 50_000;
const MIN_CRON_SECRET_LENGTH = 16;
const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

/** 一定長でない値を timingSafeEqual に渡すと RangeError になるので長さを先に見る。 */
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
 * account_delete 種別の pending intent（`expires_at` を過ぎても `preparing` のまま残った行）を
 * settle する Vercel cron エンドポイント（#2055(b)）。
 *
 * 認証・write fence・no-store の型は `external-connection-maintenance/route.ts` を踏襲する。
 * response / logs は件数と滞留時間だけを返し、user ID を含めない。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = env.CRON_SECRET?.trim();

  if (!cronSecret || cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    logger.warn('[calendar-account-deletion-settle] CRON_SECRET is not configured');
    return noStoreJson({ error: 'Cron is not configured' }, 503);
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (!safeEquals(authorization, `Bearer ${cronSecret}`)) {
    return noStoreJson({ error: 'Unauthorized' }, 401);
  }

  if (await isWriteFenceEnabled(createServiceRoleClient())) {
    logger.warn('[calendar-account-deletion-settle] write fence is enabled; skipping dispatch');
    return NextResponse.json(
      { error: 'Writes are temporarily paused for maintenance' },
      { status: 503, headers: { ...NO_STORE_HEADERS, 'retry-after': '900' } },
    );
  }

  const heartbeatStartedAt = new Date().toISOString();
  await writeCronHeartbeat('calendar-account-deletion-settle', 'started', heartbeatStartedAt);
  try {
    const summary = await dispatchCalendarAccountDeletionSettle({
      deadlineAt: Date.now() + TIME_BUDGET_MS,
    });

    if (summary.skipped) {
      logger.warn('[calendar-account-deletion-settle] settle was skipped this run');
    }
    if (summary.inFlight > 0 || summary.other > 0) {
      logger.warn('[calendar-account-deletion-settle] unresolved rows remain', {
        inFlight: summary.inFlight,
        other: summary.other,
      });
    }

    if (!summary.skipped) {
      await writeCronHeartbeat('calendar-account-deletion-settle', 'completed', heartbeatStartedAt);
    }
    return noStoreJson({ ok: true, ...summary });
  } catch (error) {
    // 常に新しい generic Error で capture する（raw error インスタンス自体は Sentry の
    // cause へ通さない）。原因の code/message は #2289 と同型の default-closed
    // errorMessage sanitizer（packages/observability/src/sanitize.ts）経由で
    // context へ伝搬し、generic dispatch failure の真因を診断可能にする（DAYOPT-V、#2305）。
    const causeCode =
      error instanceof CalendarAccountDeletionSettleError
        ? (error.causeCode ?? error.code)
        : undefined;
    const causeMessage =
      error instanceof CalendarAccountDeletionSettleError ? error.causeMessage : undefined;

    captureUnexpectedError(new Error('Calendar account deletion settle dispatch failed'), {
      feature: 'external_calendar',
      operation: 'cron_dispatch',
      route: '/api/cron/calendar-account-deletion-settle',
      ...(causeCode !== undefined ? { errorCode: causeCode } : {}),
      ...(causeMessage !== undefined ? { errorMessage: causeMessage } : {}),
    });
    logger.error('[calendar-account-deletion-settle] dispatch failed');
    return noStoreJson({ error: 'Settle dispatch failed' }, 500);
  }
}
