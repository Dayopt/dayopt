/**
 * Sentry サーバーサイド設定（Node.jsランタイム）
 *
 * このファイルはサーバーサイドでのエラー監視を設定します。
 * instrumentation.ts から動的にインポートされます。
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */

import * as Sentry from '@sentry/nextjs';

import { resolveDayoptEnvironment } from '@/lib/dayopt-environment';
import {
  scrubSentryBreadcrumb,
  scrubSentrySpan,
  scrubSentryTransaction,
  withPIIScrub,
} from '@/lib/sentry/scrub-pii';

// サーバーサイドではSENTRY_DSNを優先（ランタイム環境変数）
const SENTRY_DSN = process.env.SENTRY_DSN;
const DAYOPT_ENVIRONMENT = resolveDayoptEnvironment({
  dayoptEnvironment: process.env.DAYOPT_ENVIRONMENT,
  publicDayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
  vercelEnvironment: process.env.VERCEL_ENV,
  vercelTargetEnvironment: process.env.VERCEL_TARGET_ENV,
  vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  vercelProjectId: process.env.VERCEL_PROJECT_ID,
  vercelBranchUrl: process.env.VERCEL_BRANCH_URL,
  vercelUrl: process.env.VERCEL_URL,
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
});
const SENTRY_ENVIRONMENT =
  DAYOPT_ENVIRONMENT === 'production' || DAYOPT_ENVIRONMENT === 'integration'
    ? DAYOPT_ENVIRONMENT
    : null;

// DSNが設定されている場合のみ初期化
if (SENTRY_DSN && SENTRY_ENVIRONMENT !== null) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
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

    // Production and the explicitly bound Integration project only. Integration
    // uses Vercel's Preview target, so check the full Dayopt binding above.
    enabled: SENTRY_ENVIRONMENT !== null,

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
