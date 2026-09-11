/**
 * Upstash Redis レート制限実装
 *
 * Phase 3: 本番環境向けの永続的レート制限
 * インメモリ実装の制限（再起動でリセット）を解決
 *
 * @see https://upstash.com/docs/redis/features/ratelimiting
 * @see Issue #487 - OWASP準拠のセキュリティ強化 Phase 3
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { logger } from '@/lib/logger';
import { extractClientIp } from '@/lib/security/ip-validation';
import { captureUnexpectedError } from '@/lib/sentry';

/**
 * `@/env` の `env.X` は初回アクセス時に schema 全体（Supabase 必須3変数を含む）を検証する
 * all-or-nothing Proxy（`src/env.ts`）。generic Preview deployment は `SUPABASE_SECRET_KEY`
 * を持たない（決定ログ（削除済み、git 履歴参照））ため、この module を
 * 経由するどの route も import 時点で無関係に crash していた（#2011）。Upstash 側は本来
 * `UPSTASH_REDIS_REST_URL` / `_TOKEN` の2変数しか要らないので、`process.env` を直接読む
 * （schema 全体の fail-fast は他の operational-only module 経由で production では変わらず効く）。
 *
 * `\n` 除去 + trim は `@/env` の Proxy が既に行っている正規化（Vercel env pull が付与しうる
 * 末尾 `\n` / 空文字対策）を意図的に踏襲したもので、main の zod 検証経路には無かった追加分では
 * ない。一方で zod の `.url()` / `.min(1)` format 検証は失う——不正値の失敗タイミングが
 * 「import 時の起動時 crash」から「Redis client 生成・接続を試みる初回リクエスト時」へ
 * 後ろ倒しになるのは #2011 の修正意図どおり（無関係な route を巻き込む早期 crash を避けるのが
 * 目的なので、この後退は許容する）。
 */
function readTrimmedEnv(name: string): string | undefined {
  const trimmed = process.env[name]?.replace(/\\n/g, '').trim();
  return trimmed === '' ? undefined : trimmed;
}

const UPSTASH_REDIS_REST_URL = readTrimmedEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = readTrimmedEnv('UPSTASH_REDIS_REST_TOKEN');

/** Upstash Redisが有効かどうか（環境変数が設定されている場合のみtrue） */
export const isUpstashEnabled = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
const isProductionBuild = process.env.NEXT_PHASE === 'phase-production-build';

/**
 * Redis接続（環境変数が設定されている場合のみ）
 */
let redis: Redis | null = null;

if (isUpstashEnabled) {
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL!,
    token: UPSTASH_REDIS_REST_TOKEN!,
  });
} else if (!isProductionBuild) {
  // Production runtimeはenv validation、Production buildはapp-local build gateが不足を拒否する。
  logger.warn(
    '[RateLimit] Upstash is not configured. Falling back to in-memory rate limiting — single-instance only, breaks on multi-replica deployments.',
  );
}

export const RATE_LIMIT_TIMEOUT_MS = 2_000;

type RatelimitResponse = Awaited<ReturnType<Ratelimit['limit']>>;

interface ProductRateLimiter {
  limit(identifier: string): Promise<RatelimitResponse>;
}

export class RateLimitUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Rate-limit backend is unavailable', cause === undefined ? undefined : { cause });
    this.name = 'RateLimitUnavailableError';
  }
}

/** Upstash SDK timeoutはsuccess=trueを返すため、明示的にbackend unavailableへ変換する。 */
export function requireAvailableRateLimitResult(result: RatelimitResponse): RatelimitResponse {
  if (result.reason === 'timeout') throw new RateLimitUnavailableError();
  return result;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Upstash keyにはraw IP、user ID、tokenを残さず、secret付きHMACだけを渡す。 */
export async function hashRateLimitIdentifier(identifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const value = encoder.encode(`dayopt-product:${identifier}`);
  const secret = UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!secret) return bytesToHex(await crypto.subtle.digest('SHA-256', value));

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, value));
}

function createRateLimiter(
  limiter: ReturnType<typeof Ratelimit.slidingWindow>,
  prefix: string,
): ProductRateLimiter | null {
  if (!redis) return null;

  const rateLimit = new Ratelimit({
    redis,
    limiter,
    analytics: false,
    prefix,
    timeout: RATE_LIMIT_TIMEOUT_MS,
  });

  return {
    limit: async (identifier) =>
      requireAvailableRateLimitResult(
        await rateLimit.limit(await hashRateLimitIdentifier(identifier)),
      ),
  };
}

/**
 * お問い合わせ用レート制限
 * 5リクエスト / 1時間（Sliding Window）
 */
export const contactRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(5, '1 h'),
  'ratelimit:product:contact',
);

/** お問い合わせ配送全体の予算上限: 60リクエスト / 1時間。 */
export const contactGlobalRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(60, '1 h'),
  'ratelimit:product:contact-global',
);

const RESEND_WEBHOOK_PROCESSING_SECONDS = 5 * 60;
/** Resendの自動retryと30日間のmanual replay運用を越えて重複を抑止する。 */
export const RESEND_WEBHOOK_PROCESSED_SECONDS = 35 * 24 * 60 * 60;

type ResendWebhookClaim =
  | { status: 'claimed'; token: string }
  | { status: 'already_processed' }
  | { status: 'in_progress' };

async function getResendWebhookKey(eventId: string): Promise<string> {
  return `webhook:product:resend:${await hashRateLimitIdentifier(`resend-event:${eventId}`)}`;
}

function assertWebhookRedisAvailable(): void {
  if (!redis && process.env.VERCEL_ENV === 'production') {
    throw new RateLimitUnavailableError();
  }
}

/** Reserve a signed Resend event with a five-minute processing lease. */
export async function claimResendWebhookEvent(eventId: string): Promise<ResendWebhookClaim> {
  const token = crypto.randomUUID();
  assertWebhookRedisAvailable();
  if (!redis) return { status: 'claimed', token };

  const result = await redis.eval<[string, number], string>(
    `local current = redis.call('GET', KEYS[1])
if current == 'processed' then return 'already_processed' end
if current then return 'in_progress' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 'claimed'`,
    [await getResendWebhookKey(eventId)],
    [`processing:${token}`, RESEND_WEBHOOK_PROCESSING_SECONDS],
  );

  if (result === 'claimed') return { status: 'claimed', token };
  if (result === 'already_processed' || result === 'in_progress') return { status: result };
  throw new Error('Resend webhook claim returned an invalid state');
}

/** Mark a fully handled Resend event terminal before acknowledging it. */
export async function completeResendWebhookEvent(eventId: string, token: string): Promise<void> {
  assertWebhookRedisAvailable();
  if (!redis) return;

  const result = await redis.eval<[string, string, number], number>(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0`,
    [await getResendWebhookKey(eventId)],
    [`processing:${token}`, 'processed', RESEND_WEBHOOK_PROCESSED_SECONDS],
  );
  if (result !== 1) throw new Error('Resend webhook processing lease is no longer owned');
}

/** Release only the failed processing lease owned by this invocation. */
export async function releaseResendWebhookEvent(eventId: string, token: string): Promise<void> {
  assertWebhookRedisAvailable();
  if (!redis) return;

  await redis.eval<[string], number>(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`,
    [await getResendWebhookKey(eventId)],
    [`processing:${token}`],
  );
}

/**
 * tRPC protectedProcedure 用レート制限
 * 300リクエスト / 1分 per user（in-memory fallback の `USER_RATE_LIMIT` と同値。
 * 100 は 1 画面 15〜20 手続きの実装で実ユーザーも届く値だった。#2669）
 */
export const trpcUserRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(300, '1 m'),
  'ratelimit:product:trpc:user',
);

/**
 * パスワード再認証（captcha 免除の service-role signInWithPassword）用レート制限
 * 5リクエスト / 10分。呼び出し側が identifier に `${context}:${userId}` を渡し、
 * account 削除・メールアドレス変更など用途ごとにバケットを分離する
 * （同一 bucket にすると、一方の再認証ミスがもう一方を fail-closed で巻き添えにする）。
 *
 * GoTrue 側の signInWithPassword rate limit は呼び出し元（Vercel egress IP）単位で
 * 全ユーザー共有のため、ここで先に頭打ちにして共有バケットの枯渇を遅らせる
 * （`features/auth/server/password-reauthentication.ts` 参照）。
 */
export const reauthRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(5, '10 m'),
  'ratelimit:product:reauth',
);

/** MCP token検証前のcoarse IP ceiling。認証後は別のuser limitで絞る。 */
export const mcpPreAuthRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(1_200, '1 m'),
  'ratelimit:product:mcp:pre-auth',
);

/** MCP protected resource用: tool discovery/read/writeをuser単位でまとめて制限する。 */
export const mcpUserRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(120, '1 m'),
  'ratelimit:product:mcp:user',
);

/** OAuth token endpoint用: 未認証IP単位のDB負荷上限。 */
export const oauthTokenIpRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(10, '1 m'),
  'ratelimit:product:oauth-token:ip',
);

/**
 * OAuth token endpoint の body を読む前に置く粗い IP 上限。
 *
 * grant_type ごとに bucket を分けるには body を読む必要があり、その body 読み取り自体を
 * 無制限にしないための層。DBを引かない安価な処理だけがこの内側にある。
 */
export const oauthTokenPreBodyIpRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(600, '1 m'),
  'ratelimit:product:oauth-token:pre-body-ip',
);

/**
 * refresh grant 用: refresh token 単位の上限。
 *
 * claude.ai / ChatGPT のような server-side client は全ユーザー分の refresh を少数の
 * egress IP から送る。access token は 5 分で切れるため、IP 単位の 10/分 に refresh を
 * 相乗りさせると、同一 provider 経由の接続が増えた時点で **全ユーザーの refresh が
 * 巻き添えで 429 になる**（#2721 D-01）。token 単位なら他の接続に波及しない。
 */
export const oauthTokenRefreshRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(30, '1 m'),
  'ratelimit:product:oauth-token:refresh',
);

/**
 * refresh grant の IP 単位上限。**token 単位の上限と AND で使う。**
 *
 * bucket key の材料（refresh token）は検証前の body なので、攻撃者は毎回別の値を
 * 送って per-token bucket を無限に作れる。token 単位だけだと 1 IP から全体上限
 * （`oauthTokenGlobalRateLimit`）を飽和させられ、正規ユーザーの token 更新が
 * 巻き添えで止まる。共有 egress IP を締め出さないよう、`authorization_code` 用の
 * 10/分 より緩くする。
 */
export const oauthTokenRefreshIpRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(120, '1 m'),
  'ratelimit:product:oauth-token:refresh-ip',
);

/** OAuth token endpoint全体のDB負荷上限。 */
export const oauthTokenGlobalRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(120, '1 m'),
  'ratelimit:product:oauth-token:global',
);

/**
 * エントリ作成の日次上限
 * 500リクエスト / 24時間 per user
 */
export const timeblockCreateRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(500, '24 h'),
  'ratelimit:product:timeblock:create',
);

/**
 * iCalフィード用レート制限
 * 10リクエスト / 1分 per token（外部カレンダーアプリからの購読用）
 */
export const icalFeedRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(10, '1 m'),
  'ratelimit:product:ical-feed',
);

/**
 * iCalフィードの事前認証集約上限（IP単位）。per-token上限より前に評価する。
 *
 * Google/Apple/Outlook等のフェッチャーは共有IPプールから購読を取得するため、上限は
 * 30/minのような厳しい値にせず60/minに緩めている（暫定値。本番トラフィック未計測）。
 * 到達時はSentryへcaptureし運用中に観測・調整する前提。
 */
export const icalFeedIpRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(60, '1 m'),
  'ratelimit:product:ical-feed-ip',
);

/**
 * 認証前の tRPC 境界用: cookie 付きリクエストの IP 単位上限。
 *
 * `protectedProcedure` の 300/分 は `ctx.userId` が確定した後にしか働かない
 * （`procedures.ts`）。cookie を持つ未認証リクエストは、その手前で毎回
 * Supabase Auth の `getUser()` を駆動できる（#2721 D-06）。cookie 無しは
 * auth-js が外部通信せず短絡するため、この層は cookie 付きだけに掛ける。
 *
 * ユーザー単位の 300/分 より緩くして、NAT 越しの同居ユーザーを巻き込まない。
 */
export const trpcPreAuthIpRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(600, '1 m'),
  'ratelimit:product:trpc:pre-auth-ip',
);

/**
 * `/api/health` 用の全体上限。
 *
 * 無認証・無制限で service-role の DB 疎通と Redis PING を駆動できる（#2721 D-09）。
 * 外形監視を止めないため、超過時は 503 ではなく直近の結果を返す。
 */
export const healthCheckGlobalRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(120, '1 m'),
  'ratelimit:product:health:global',
);

/** iCalフィード全体の集約上限（暫定値）。service-role DB lookupを保護する。 */
export const icalFeedGlobalRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(600, '1 m'),
  'ratelimit:product:ical-feed-global',
);

/**
 * 外部カレンダー接続用レート制限（start / callback 共通）
 * 10リクエスト / 1時間 per user（OAuth 接続は人間の操作なので低頻度で足りる）
 *
 * callback にも掛けるのは、flow cookie を意図的に署名していないためユーザー自身が
 * 任意の state を作れて、start を踏まずに callback を叩き続けられるから。無制限だと
 * Google の token endpoint への往復と Sentry capture が青天井になる。
 * 正常な接続は start + callback で 2 消費するので、1 時間に 5 回まで試せる。
 *
 * IP ではなく user 単位。connect は認証済みユーザーの操作であり、共有 IP 配下の
 * 別ユーザーを巻き込まない。
 */
export const calendarConnectRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(10, '1 h'),
  'ratelimit:product:calendar-connect',
);

/**
 * 手動同期（tRPC `syncNow`）の per-user rate limit。
 *
 * 1 回で全カレンダーの provider 往復が走るので、連打を抑える。cron が 15 分毎に回すため、
 * 手動同期は補助的な導線であり 1 時間 6 回で足りる。
 */
export const calendarSyncNowRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(6, '1 h'),
  'ratelimit:product:calendar-sync-now',
);

/** CSP reportは公開入力なのでIP単位と全体上限を別々に持つ。 */
export const cspReportRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(20, '1 m'),
  'ratelimit:product:csp-report',
);

export const cspReportGlobalRateLimit = createRateLimiter(
  Ratelimit.slidingWindow(120, '1 m'),
  'ratelimit:product:csp-report-global',
);

/**
 * 汎用レート制限ミドルウェア
 *
 * @example
 * ```typescript
 * import { withUpstashRateLimit } from '@/lib/rate-limit/upstash'
 *
 * export async function POST(request: Request) {
 *   const result = await withUpstashRateLimit(request, contactRateLimit)
 *
 *   if (result.state === 'unavailable') return new Response('Unavailable', { status: 503 })
 *   if (result.state === 'checked' && !result.success) {
 *     return new Response('Too Many Requests', {
 *       status: 429,
 *       headers: {
 *         'X-RateLimit-Limit': result.limit.toString(),
 *         'X-RateLimit-Remaining': result.remaining.toString(),
 *         'X-RateLimit-Reset': result.reset.toString(),
 *         'Retry-After': Math.ceil((result.reset - Date.now()) / 1000).toString(),
 *       }
 *     })
 *   }
 *
 *   // 処理続行
 * }
 * ```
 */
type RateLimitCheckResult =
  | { state: 'disabled' }
  | { state: 'unavailable' }
  | ({ state: 'checked' } & Pick<
      RatelimitResponse,
      'success' | 'limit' | 'remaining' | 'reset' | 'pending'
    >);

export async function withUpstashRateLimit(
  request: Request,
  rateLimit: ProductRateLimiter | null,
): Promise<RateLimitCheckResult> {
  if (!rateLimit) {
    return { state: 'disabled' };
  }

  const ipIdentifier = getClientIdentifier(request);

  try {
    return toCheckedRateLimitResult(await rateLimit.limit(ipIdentifier));
  } catch (error) {
    logger.error('[RateLimit] Upstash rate limit check failed');
    const original = error instanceof Error ? error : new Error('Upstash rate limit check failed');
    captureUnexpectedError(original, {
      feature: 'rate_limit',
      operation: 'upstash_rate_limit_check',
      source: 'upstash',
    });
    return { state: 'unavailable' };
  }
}

function toCheckedRateLimitResult(
  result: RatelimitResponse,
): Extract<RateLimitCheckResult, { state: 'checked' }> {
  const { success, limit, remaining, reset, pending } = result;
  return { state: 'checked', success, limit, remaining, reset, pending };
}

/**
 * クライアント識別子の取得
 * 公開requestは検証済みIPを使い、limiter factory内でHMAC-SHA-256化する。
 */
function getClientIdentifier(request: Request): string {
  // Vercelが上書きするX-Real-IPだけを信頼する。別CDNを追加する場合は再評価する。
  const ip = extractClientIp(request.headers.get('x-real-ip'));

  return `ip:${ip}`;
}

/**
 * レート制限プリセット
 *
 * 一般的な用途に応じた設定例
 */
export const RATE_LIMIT_PRESETS = {
  // 一般API（緩い）
  api: {
    requests: 60,
    window: '1 m',
    description: '60リクエスト/分',
  },

  // 認証エンドポイント（厳しい）
  auth: {
    requests: 5,
    window: '15 m',
    description: '5リクエスト/15分',
  },

  // パスワードリセット（非常に厳しい）
  passwordReset: {
    requests: 3,
    window: '1 h',
    description: '3リクエスト/時間',
  },

  // 検索（中程度）
  search: {
    requests: 30,
    window: '1 m',
    description: '30リクエスト/分',
  },

  // ファイルアップロード（厳しい）
  upload: {
    requests: 10,
    window: '1 h',
    description: '10リクエスト/時間',
  },
} as const;

/**
 * コスト見積もり
 *
 * Upstash料金（2024年時点）:
 * - 無料枠: 10,000リクエスト/日
 * - Pay-as-you-go: $0.2/100,000リクエスト
 *
 * Dayopt想定:
 * - DAU: 1,000ユーザー
 * - 1ユーザーあたり平均: 100リクエスト/日
 * - 合計: 100,000リクエスト/日 = 3,000,000リクエスト/月
 *
 * 月額コスト: 3,000,000 / 100,000 * $0.2 = $6
 *
 * → 非常にコストパフォーマンスが高い
 */
export const UPSTASH_COST_ESTIMATE = {
  freeQuota: 10_000,
  pricePerHundredThousand: 0.2,
  estimatedMonthlyRequests: 3_000_000,
  estimatedMonthlyCost: 6,
} as const;
