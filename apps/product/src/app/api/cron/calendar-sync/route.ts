import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import { dispatchCalendarSync } from '@/features/external-calendar/server/sync-dispatcher';
import { logger } from '@/lib/logger';
import { writeCronHeartbeat } from '@/lib/ops/cron-heartbeat';
import { isWriteFenceEnabled } from '@/lib/ops/write-fence';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/**
 * 外部カレンダー同期の Vercel cron エンドポイント（overview.md §6-1）。
 *
 * Vercel が 15 分毎に GET で叩く。`CRON_SECRET` を Bearer で照合し、due な接続を時間予算内で
 * 逐次同期する。同期本体は sync-service / dispatcher が持ち、ここは認証と予算設定だけ。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 1 回の実行に許す最大秒数。Vercel の Function 上限内に収める（既存 webhook route が 30 で
 * 稼働中 = plan 上限は 30 以上）。複数接続を逐次処理するので webhook より長めに取る。
 */
export const maxDuration = 60;

/** maxDuration に対する安全マージン。この ms を締切にして途中で打ち切る。 */
const TIME_BUDGET_MS = 50_000;

/** 一定長でない値を timingSafeEqual に渡すと RangeError になるので長さを先に見る。 */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = env.CRON_SECRET?.trim();

  // secret 未設定 = calendar 連携が未構成。callback route の config guard と同じく 503。
  if (!cronSecret) {
    logger.warn('[calendar-cron] CRON_SECRET is not configured');
    return NextResponse.json({ error: 'Cron is not configured' }, { status: 503 });
  }

  // Vercel は cron リクエストの Authorization ヘッダに `Bearer <CRON_SECRET>` を載せる。
  // 不一致 / 欠如は 401。詳細を body に出さず route を公開情報にしない。
  const authorization = request.headers.get('authorization') ?? '';
  if (!safeEquals(authorization, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (await isWriteFenceEnabled(createServiceRoleClient())) {
    logger.warn('[calendar-cron] write fence is enabled; skipping dispatch');
    return NextResponse.json(
      { error: 'Writes are temporarily paused for maintenance' },
      { status: 503, headers: { 'retry-after': '900' } },
    );
  }

  const heartbeatStartedAt = new Date().toISOString();
  await writeCronHeartbeat('calendar-sync', 'started', heartbeatStartedAt);
  try {
    const summary = await dispatchCalendarSync({
      now: new Date(),
      deadlineAt: Date.now() + TIME_BUDGET_MS,
    });
    await writeCronHeartbeat('calendar-sync', 'completed', heartbeatStartedAt);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    captureUnexpectedError(error instanceof Error ? error : new Error('calendar cron failed'), {
      feature: 'external_calendar',
      operation: 'cron_dispatch',
      route: '/api/cron/calendar-sync',
    });
    logger.error('[calendar-cron] dispatch failed');
    return NextResponse.json({ error: 'Sync dispatch failed' }, { status: 500 });
  }
}
