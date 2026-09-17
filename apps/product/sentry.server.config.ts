/**
 * Sentry サーバーサイド設定（Node.jsランタイム）
 *
 * このファイルはサーバーサイドでのエラー監視を設定します。
 * instrumentation.ts から動的にインポートされます。
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */

import * as Sentry from '@sentry/nextjs';

import {
  scrubSentryBreadcrumb,
  scrubSentrySpan,
  scrubSentryTransaction,
  withPIIScrub,
} from '@/lib/sentry/scrub-pii';

// サーバーサイドではSENTRY_DSNを優先（ランタイム環境変数）
const SENTRY_DSN = process.env.SENTRY_DSN;
// VERCEL_ENVはVercelが自動設定（production, preview, development）
const VERCEL_ENV = process.env.VERCEL_ENV;
const IS_SENTRY_PRODUCTION = VERCEL_ENV === 'production';

// DSNが設定されている場合のみ初期化
if (SENTRY_DSN && IS_SENTRY_PRODUCTION) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: 'production',
    sendDefaultPii: false,
    // release は withSentryConfig が build 時に注入する（next.config の release.name = VERCEL_GIT_COMMIT_SHA）。
    // ここで明示すると source map upload 時の release と runtime がズレるため上書きしない。

    tracesSampler: ({ inheritOrSampleWith }) => inheritOrSampleWith(0.1),

    // #2728: Supabase logs と trace_id で相関させるため、W3C traceparent を送出する。
    // 既定は false で sentry-trace / baggage しか書かず、supabase-js は
    // 「非 W3C propagator」として header を付けない。sampling 方針は変えない。
    propagateTraceparent: true,

    // デバッグモード（開発環境のみ）
    debug: false,

    // 本番環境のみ有効。preview は NODE_ENV=production だが VERCEL_ENV=preview なので除外
    // （IS_PRODUCTION では preview を除外できない）。
    enabled: IS_SENTRY_PRODUCTION,

    // 固定protocol allowlistとpath-aware規則で、相関IDを保持しつつPIIを除去する。
    beforeSend: withPIIScrub(),
    beforeSendTransaction: scrubSentryTransaction,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,

    // サーバーサイド用インテグレーション
    integrations: [
      // tRPC統合（エラーコンテキスト強化）
      Sentry.extraErrorDataIntegration({
        depth: 5,
      }),
    ],
  });
}
