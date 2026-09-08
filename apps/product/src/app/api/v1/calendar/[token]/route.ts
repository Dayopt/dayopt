/**
 * iCalフィード API
 *
 * GET /api/v1/calendar/{token}.ics
 *
 * 秘密トークンURLでユーザーのエントリをiCalendar形式で返却。
 * Google Calendar等で「URLで追加」して購読可能。
 *
 * 認証: トークンベース（Cookie/JWT不要、RLSバイパス）
 */

import { NextRequest, NextResponse } from 'next/server';

import { plansToICal } from '@/features/timeblock';
import { getBillingAccess } from '@/lib/billing/access-service';
import { isBillingEnforced } from '@/lib/billing/enforcement-flag';
import { logger } from '@/lib/logger';
import {
  icalFeedGlobalRateLimit,
  icalFeedIpRateLimit,
  icalFeedRateLimit,
} from '@/lib/rate-limit/upstash';
import { extractClientIp } from '@/lib/security/ip-validation';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/** DB からのトークン解決 + 最大1000件のプラン取得 + iCal 変換の合算。 */
export const maxDuration = 60;

/**
 * トークンからユーザーIDを取得
 */
async function getUserIdByToken(token: string): Promise<string | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('ical_feed_token', token)
    .maybeSingle();

  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'calendar_feed',
      operation: 'resolve_feed_token',
      route: '/api/v1/calendar/[token]',
    });
  }
  if (!data) return null;
  return data.user_id;
}

/**
 * ユーザーのエントリを取得（タグ名含む）
 */
async function getPlansForFeed(userId: string) {
  const supabase = createServiceRoleClient();

  // 過去90日〜未来90日のエントリを取得
  const now = new Date();
  const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data: plans, error } = await supabase
    .from('plans')
    .select(
      `
      id,
      title,
      note,
      start_at,
      end_at,
      created_at,
      updated_at
    `,
    )
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('start_at', past)
    .lte('start_at', future)
    .order('start_at', { ascending: true })
    .limit(1000);

  if (error) {
    logger.error('iCal feed plans fetch failed');
    throw captureUnexpectedDatabaseError(error, {
      feature: 'calendar_feed',
      operation: 'fetch_feed_plans',
      route: '/api/v1/calendar/[token]',
    });
  }

  return (plans ?? []).map((plan) => {
    return {
      id: plan.id,
      title: plan.title,
      description: plan.note,
      start_time: plan.start_at,
      end_time: plan.end_at,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
    };
  });
}

/**
 * UUIDv4形式かどうかの簡易バリデーション
 */
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

/**
 * per-token インメモリレート制限（Upstash未設定時のフォールバック）
 *
 * Vercel Serverless では関数インスタンスが再利用される間だけ有効。
 */
const TOKEN_RATE_LIMIT = 10;
const TOKEN_RATE_WINDOW_MS = 60 * 1000;
/** hard cardinality 上限。超過分は挿入順(≒最古アクセス順)で捨てる。 */
const TOKEN_RATE_LOG_MAX_ENTRIES = 500;
const tokenRequestLog = new Map<string, number[]>();

function isRateLimitedInMemory(token: string): boolean {
  const now = Date.now();
  const timestamps = tokenRequestLog.get(token) ?? [];
  const recent = timestamps.filter((t) => now - t < TOKEN_RATE_WINDOW_MS);
  recent.push(now);
  // 既存キーの再設定はMapの挿入順を末尾へ更新する(擬似LRU)。
  tokenRequestLog.delete(token);
  tokenRequestLog.set(token, recent);

  while (tokenRequestLog.size > TOKEN_RATE_LOG_MAX_ENTRIES) {
    const oldestKey = tokenRequestLog.keys().next().value;
    if (oldestKey === undefined) break;
    tokenRequestLog.delete(oldestKey);
  }

  return recent.length > TOKEN_RATE_LIMIT;
}

/**
 * Upstash優先 → インメモリフォールバックのレート制限チェック
 */
async function checkRateLimit(token: string): Promise<{
  limited: boolean;
  retryAfter?: string;
  headers?: Record<string, string>;
}> {
  // Upstash が有効な場合はそちらを使用
  if (icalFeedRateLimit) {
    try {
      const { success, limit, remaining, reset } = await icalFeedRateLimit.limit(`ical:${token}`);
      if (!success) {
        const retryAfter = Math.ceil((reset - Date.now()) / 1000).toString();
        return {
          limited: true,
          retryAfter,
          headers: {
            'X-RateLimit-Limit': limit.toString(),
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString(),
            'Retry-After': retryAfter,
          },
        };
      }
      return { limited: false };
    } catch (error) {
      // Redis障害時はインメモリにフォールバック(可用性優先)。ただしIP/global集約層が
      // 先に例外→unavailable(503)を返すため、ここに到達するのは集約層は生きていて
      // per-tokenだけ失敗する部分障害の場合に限る。
      const original =
        error instanceof Error
          ? error
          : new Error('iCal rate limit check failed', { cause: error });
      captureUnexpectedError(original, {
        feature: 'calendar_feed',
        operation: 'check_rate_limit',
        route: '/api/v1/calendar/[token]',
        source: 'upstash',
      });
      logger.warn('iCal rate limit failed; using in-memory fallback');
    }
  }

  // インメモリフォールバック
  if (isRateLimitedInMemory(token)) {
    return { limited: true, retryAfter: '60' };
  }
  return { limited: false };
}

type AggregateRateLimitState = 'allowed' | 'limited' | 'unavailable';

/**
 * IPv6は/128(フルアドレス)のまま bucket key にすると、攻撃者が/64割り当て内の
 * 2^64通りのアドレスを使い分けてIP単位の上限を素通りできる(残る防壁がglobalの
 * 共有バケットだけになり、単一攻撃者が全購読者を巻き込める)。/64プレフィックス
 * まで丸めてbucket化する。IPv4はそのまま(ホスト単位の粒度で問題ない)。
 */
function aggregateIpIdentifier(ip: string): string {
  if (!ip.includes(':')) return `ip:${ip}`;

  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const prefixGroups =
    tail === undefined
      ? headGroups.slice(0, 4)
      : [...headGroups, ...Array(Math.max(0, 4 - headGroups.length)).fill('0')].slice(0, 4);

  return `ip6:${prefixGroups.join(':')}`;
}

/** Upstash障害中のcapture floodを抑えるサンプリング窓(#1979と同じ理由)。 */
const AGGREGATE_FAILURE_CAPTURE_WINDOW_MS = 60_000;
let lastAggregateFailureCaptureAt = 0;
/**
 * 429到達(limited)用の別窓。障害(exception)と閾値到達(limited)は意味が違う
 * ため別々にサンプリングし、片方の連発がもう片方の観測を握り潰さないようにする。
 */
const AGGREGATE_LIMIT_HIT_CAPTURE_WINDOW_MS = 60_000;
let lastAggregateLimitHitCaptureAt = 0;

/**
 * platform-trusted IP → global の順で評価する事前認証集約上限。
 *
 * per-token 上限より前に置き、token 解決(DB lookup)の手前で高cardinalityな
 * 未認証trafficを弾く。`lib/oauth-server/token-rate-limit.ts` の
 * `checkOAuthTokenRateLimit` と同型の fail-closed 方針: limiter未設定は
 * production では unavailable、それ以外は allowed。例外は常に unavailable
 * (可用性優先フォールバックにしない。集約層はDB保護が目的のため)。
 */
async function checkAggregateRateLimit(
  limiter: typeof icalFeedIpRateLimit,
  identifier: string,
  operation: string,
): Promise<AggregateRateLimitState> {
  if (!limiter) {
    return process.env.VERCEL_ENV === 'production' ? 'unavailable' : 'allowed';
  }

  try {
    const { success } = await limiter.limit(identifier);
    if (!success) {
      logger.warn(`iCal feed aggregate rate limit exceeded: ${operation}`);
      const now = Date.now();
      if (now - lastAggregateLimitHitCaptureAt >= AGGREGATE_LIMIT_HIT_CAPTURE_WINDOW_MS) {
        lastAggregateLimitHitCaptureAt = now;
        captureUnexpectedError(new Error(`iCal feed aggregate rate limit exceeded: ${operation}`), {
          feature: 'calendar_feed',
          operation,
          route: '/api/v1/calendar/[token]',
          source: 'upstash',
        });
      }
    }
    return success ? 'allowed' : 'limited';
  } catch (error) {
    const now = Date.now();
    if (now - lastAggregateFailureCaptureAt >= AGGREGATE_FAILURE_CAPTURE_WINDOW_MS) {
      lastAggregateFailureCaptureAt = now;
      const original =
        error instanceof Error ? error : new Error('iCal feed aggregate rate limit check failed');
      captureUnexpectedError(original, {
        feature: 'calendar_feed',
        operation,
        route: '/api/v1/calendar/[token]',
        source: 'upstash',
      });
    }
    logger.error('iCal feed aggregate rate limit check failed');
    return 'unavailable';
  }
}

async function checkAggregatePreAuthCeiling(
  request: NextRequest,
): Promise<AggregateRateLimitState> {
  const ip = extractClientIp(request.headers.get('x-real-ip'));
  const ipState = await checkAggregateRateLimit(
    icalFeedIpRateLimit,
    aggregateIpIdentifier(ip),
    'check_ip_rate_limit',
  );
  if (ipState !== 'allowed') return ipState;

  return checkAggregateRateLimit(icalFeedGlobalRateLimit, 'global', 'check_global_rate_limit');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token: rawToken } = await params;

    // .ics 拡張子を除去
    const token = rawToken.replace(/\.ics$/, '');

    // UUID形式チェックはI/Oを伴わず無料で弾けるため、集約rate limit(Redis呼び出し)
    // より前に置く。形式不正なjunk requestにRedis呼び出しやcaptureを消費させない。
    if (!isValidUUID(token)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    const aggregateState = await checkAggregatePreAuthCeiling(request);
    if (aggregateState === 'limited') {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
    if (aggregateState === 'unavailable') {
      return NextResponse.json({ error: 'Calendar feed unavailable' }, { status: 503 });
    }

    // per-token レート制限（Upstash優先、インメモリフォールバック）
    const rateLimit = await checkRateLimit(token);
    if (rateLimit.limited) {
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: rateLimit.headers ?? { 'Retry-After': rateLimit.retryAfter ?? '60' },
        },
      );
    }

    // トークンでユーザー特定
    const userId = await getUserIdByToken(token);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (
      isBillingEnforced() &&
      !(await getBillingAccess(createServiceRoleClient(), userId)).canUseProduct
    ) {
      return NextResponse.json(
        { error: 'Open Dayopt to start a trial or subscribe to resume the feed' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // エントリ取得 → iCal変換
    const plans = await getPlansForFeed(userId);
    const ical = plansToICal(plans);

    return new NextResponse(ical, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="dayopt.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error) {
    const original =
      error instanceof Error ? error : new Error('Unexpected iCal feed failure', { cause: error });
    captureUnexpectedError(original, {
      feature: 'calendar_feed',
      operation: 'serve_feed',
      route: '/api/v1/calendar/[token]',
    });
    logger.error('iCal feed request failed');
    return NextResponse.json({ error: 'Calendar feed unavailable' }, { status: 500 });
  }
}
