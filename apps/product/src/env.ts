/**
 * サーバーサイド環境変数のZodバリデーション
 *
 * NEXT_PUBLIC_* はNext.jsがビルド時に置換するため、
 * クライアントコード（client.ts等）では従来通り process.env を直接参照する。
 * このファイルはサーバーサイドでのみ import する。
 */
import 'server-only';

import { z } from 'zod';

import { isValidOAuthRedirectUriList } from '@/lib/oauth-server/redirect-uris';

function isDayoptEmailAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return domain === 'dayopt.app';
}

function isRedirectUriList(value: string | undefined): boolean {
  if (!value) return true;
  return value
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean)
    .every((uri) => {
      if (uri.includes('*')) return false;
      try {
        new URL(uri);
        return true;
      } catch {
        return false;
      }
    });
}

/** AES-256 の鍵は base64 で 32 バイトに decode できなければならない。 */
function isBase64EncodedAes256Key(value: string | undefined): boolean {
  if (!value) return true;
  return Buffer.from(value.trim(), 'base64').length === 32;
}

const serverSchema = z
  .object({
    // Supabase
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SUPABASE_SECRET_KEY: z.string().min(1),

    // Upstash Redis
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

    // Resend
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().email().optional(),

    // Cloudflare Turnstile (client-side site key only; secret is stored in Supabase Auth Bot Protection)
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),

    // Auth
    RECOVERY_CODE_PEPPER: z.string().optional(),
    OAUTH_CLAUDE_REDIRECT_URIS: z
      .string()
      .optional()
      .refine((value) => isValidOAuthRedirectUriList('claude-ai', value), {
        message: 'OAUTH_CLAUDE_REDIRECT_URIS はClaude所有の登録済みcallbackだけを指定してください',
      }),
    OAUTH_CHATGPT_REDIRECT_URIS: z
      .string()
      .optional()
      .refine((value) => isValidOAuthRedirectUriList('chatgpt', value), {
        message:
          'OAUTH_CHATGPT_REDIRECT_URIS はChatGPT所有の登録済みcallbackだけを指定してください',
      }),
    OAUTH_CURSOR_REDIRECT_URIS: z
      .string()
      .optional()
      .refine((value) => isValidOAuthRedirectUriList('cursor', value), {
        message: 'OAUTH_CURSOR_REDIRECT_URIS はCursor所有の登録済みcallbackだけを指定してください',
      }),
    // MCP / OAuth の deployment identity。env.ts は宣言だけを持ち、値の整合は
    // `lib/oauth-server/identity-env.ts` が呼ばれた時点で検証する。ここで
    // superRefine すると build phase / CI で skip される Proxy を通り抜け、
    // production cold start で MCP と無関係な全ページが 500 になる。
    MCP_OAUTH_ENVIRONMENT: z.enum(['production', 'preview']).optional(),
    MCP_OAUTH_PREVIEW_BRANCH: z.string().min(1).optional(),
    MCP_OAUTH_PREVIEW_UPSTASH_HOST: z.string().min(1).optional(),
    OAUTH_AUTHORIZATION_SERVER_URI: z.string().url().optional(),
    MCP_CANONICAL_RESOURCE_URI: z.string().url().optional(),
    /** MCP write の runtime allowlist。未設定 = 全 client の write を拒否する。 */
    MCP_WRITE_ENABLED_CLIENTS: z.string().optional(),

    // Google
    GOOGLE_SITE_VERIFICATION: z.string().optional(),

    // Google Calendar 連携（external-calendar-import）。Supabase Auth の Google provider とは
    // 別の専用 OAuth client を使う。identity（誰か）と data-access（何を読めるか）を分離する。
    GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
    // Calendar authority を有効化する時だけ必須。OAuth client ID の project number と照合する。
    // Candidate 3 では gate を OFF のまま配置するため、既存環境との互換性を保って optional とする。
    GOOGLE_CALENDAR_PROJECT_NUMBER: z
      .string()
      .regex(/^[1-9][0-9]{5,29}$/)
      .optional(),
    GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
    // refresh token の AES-256-GCM 暗号鍵。base64 で 32 バイト（`openssl rand -base64 32`）。
    // 長さを boot 時に検証する。壊れた鍵のまま起動すると、同意まで取ったあと保存だけが失敗する。
    CALENDAR_TOKEN_ENCRYPTION_KEY: z.string().optional().refine(isBase64EncodedAes256Key, {
      message: 'CALENDAR_TOKEN_ENCRYPTION_KEY は base64 で 32 バイトの鍵にしてください',
    }),
    // Google は redirect_uri の完全一致を要求しワイルドカードを許さない。環境ごとに登録済みの
    // URI をカンマ区切りで持ち、route 側は request host と完全一致するものを lookup して使う。
    // Vercel Production にはproduction origin だけを入れる（localhost を混ぜると
    // x-forwarded-host 経由で allowlist を通過されうる）。
    GOOGLE_CALENDAR_REDIRECT_URIS: z.string().optional().refine(isRedirectUriList, {
      message:
        'GOOGLE_CALENDAR_REDIRECT_URIS は完全な redirect URI のカンマ区切りで指定してください',
    }),
    // Vercel cron（/api/cron/calendar-sync）の Bearer 認証。Vercel が cron リクエストの
    // Authorization ヘッダに載せる値と route 側で timingSafeEqual 照合する。calendar 連携で
    // 使うが、下の「全部揃うか無いか」refine には含めない（理由は refine 側のコメント）。
    CRON_SECRET: z.string().optional(),

    // Stripe
    STRIPE_SECRET_KEY: z.string().optional(),
    // Billing lifecycle のactive経路でprovider identityを固定する。未設定時はactive経路を拒否する。
    STRIPE_ACCOUNT_ID: z
      .string()
      .regex(/^acct_[A-Za-z0-9_]+$/)
      .optional(),
    STRIPE_LIVEMODE: z.enum(['true', 'false']).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    NEXT_PUBLIC_STRIPE_PRO_PRICE_ID: z.string().optional(),

    // App
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    NEXT_PUBLIC_APP_URL: z.string().url().optional(),
    NEXT_PUBLIC_MAINTENANCE_MODE: z.enum(['true', 'false']).optional(),
    // 課金 enforcement。未設定（既定）= 無効＝全機能無料。
    // Phase B（成熟・ローンチ前）に production を 'true' にして Free/Pro 棲み分けを復活させる。
    BILLING_ENFORCED: z.enum(['true', 'false']).optional(),
    VERCEL_URL: z.string().optional(),
    VERCEL_ENV: z.string().optional(),
    VERCEL_TARGET_ENV: z.string().optional(),
    VERCEL_BRANCH_URL: z.string().optional(),
    VERCEL_GIT_COMMIT_REF: z.string().optional(),
    SKIP_AUTH_IN_DEV: z.string().optional(),
  })
  .refine((data) => !(data.NODE_ENV === 'production' && data.SKIP_AUTH_IN_DEV === 'true'), {
    message: 'SKIP_AUTH_IN_DEV は本番環境では使用できない',
    path: ['SKIP_AUTH_IN_DEV'],
  })
  .refine((data) => !(data.NODE_ENV === 'production' && !data.RECOVERY_CODE_PEPPER), {
    message: 'RECOVERY_CODE_PEPPER は本番環境では必須です',
    path: ['RECOVERY_CODE_PEPPER'],
  })
  .refine(
    (data) => {
      if (!(data.NODE_ENV === 'production' && process.env.VERCEL_ENV === 'production')) {
        return true;
      }
      const hasKey = !!data.STRIPE_SECRET_KEY;
      const hasWebhook = !!data.STRIPE_WEBHOOK_SECRET;
      return hasKey === hasWebhook;
    },
    {
      message: 'STRIPE_SECRET_KEY と STRIPE_WEBHOOK_SECRET は本番環境ではペアで設定してください',
      path: ['STRIPE_WEBHOOK_SECRET'],
    },
  )
  .refine(
    (data) =>
      // Vercel preview deployment は NODE_ENV=production だが VERCEL_ENV=preview。
      // generic Preview は手動アクセスのみだが、MCP OAuth を明示的に有効にする Preview は
      // 外部 client から到達するため distributed rate limit を必須にする。
      !(
        data.NODE_ENV === 'production' &&
        (process.env.VERCEL_ENV === 'production' || data.MCP_OAUTH_ENVIRONMENT === 'preview') &&
        (!data.UPSTASH_REDIS_REST_URL || !data.UPSTASH_REDIS_REST_TOKEN)
      ),
    {
      message:
        'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN はoperational環境では必須です（インメモリfallbackはmulti-replicaで歯抜けになる）',
      path: ['UPSTASH_REDIS_REST_URL'],
    },
  )
  .refine(
    (data) => {
      if (!(data.NODE_ENV === 'production' && data.VERCEL_ENV === 'production')) return true;

      const sender = data.RESEND_FROM_EMAIL?.trim().toLowerCase();
      return Boolean(
        data.RESEND_API_KEY?.trim() &&
        data.RESEND_WEBHOOK_SECRET?.trim() &&
        sender &&
        sender !== 'onboarding@resend.dev' &&
        isDayoptEmailAddress(sender),
      );
    },
    {
      message:
        'RESEND_API_KEY / apex dayopt.app RESEND_FROM_EMAIL / RESEND_WEBHOOK_SECRET はVercel Productionで必須です',
      path: ['RESEND_API_KEY'],
    },
  )
  .refine(
    (data) => {
      if (!(data.NODE_ENV === 'production' && data.VERCEL_ENV === 'production')) return true;

      // 「全部揃うか全部無いか」。4 変数のうち一部だけ入っている状態は、connect フローが
      // 途中まで動いて失敗する最悪の中間状態になるので許さない。
      // 全部無い場合は route 側の config guard が 503 を返す。
      //
      // CRON_SECRET はここに含めない。あれは `human/supabase` item の汎用 secret
      // （`scripts/tasks/env/schema.ts` 参照）で、google-calendar item とはライフサイクルが別。
      // 含めると「CRON_SECRET だけ既に設定済み + calendar 未設定」の現実的な状態で env 検証が
      // 落ち、cron どころかアプリ全体が起動不能になる。cron 側は secret 未設定なら route が
      // 503 を返して静かに無効化されるので、そちらの degradation で足りる。
      const values = [
        data.GOOGLE_CALENDAR_CLIENT_ID,
        data.GOOGLE_CALENDAR_CLIENT_SECRET,
        data.CALENDAR_TOKEN_ENCRYPTION_KEY,
        data.GOOGLE_CALENDAR_REDIRECT_URIS,
      ].map((value) => Boolean(value?.trim()));

      return values.every(Boolean) || !values.some(Boolean);
    },
    {
      message:
        'GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET / CALENDAR_TOKEN_ENCRYPTION_KEY / GOOGLE_CALENDAR_REDIRECT_URIS は本番環境ではまとめて設定してください',
      path: ['GOOGLE_CALENDAR_CLIENT_ID'],
    },
  );

type ServerEnv = z.infer<typeof serverSchema>;

let _validated = false;

/**
 * サーバーサイド環境変数
 *
 * process.env へのアクセスをProxy経由で提供する。
 * - dev/production ランタイム: 初回アクセス時にZodバリデーションを実行（不足があればthrow）
 * - ビルド時/テスト時/CI: バリデーションをスキップし process.env を直接返す
 */
export const env = new Proxy({} as ServerEnv, {
  get(_target, prop: string) {
    // テスト・ビルド・CI環境ではバリデーションをスキップ
    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
    const isCI = process.env.CI === 'true';

    if (!isTest && !isBuild && !isCI && !_validated) {
      // Vercel env pull が末尾に \n を付与したり空文字をセットすることがあるため正規化
      const cleaned: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(process.env)) {
        const trimmed = value?.replace(/\\n/g, '').trim();
        cleaned[key] = trimmed === '' ? undefined : trimmed;
      }
      const result = serverSchema.safeParse(cleaned);
      if (!result.success) {
        const formatted = result.error.issues
          .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
          .join('\n');
        throw new Error(
          `❌ 環境変数のバリデーションに失敗しました:\n${formatted}\n\n` +
            `.op-env.agent を作成し、op run 経由で起動してください。詳細は docs/operations/secrets.md を参照してください。`,
        );
      }
      _validated = true;
    }

    return process.env[prop];
  },
});
