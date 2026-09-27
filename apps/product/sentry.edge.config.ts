/**
 * Sentry Edge設定（Edge Runtime）
 *
 * Middleware、Edge API Routes用の軽量設定。
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

// Edge環境ではSENTRY_DSNを優先（ランタイム環境変数）
const SENTRY_DSN = process.env.SENTRY_DSN;
const DAYOPT_ENVIRONMENT = resolveDayoptEnvironment({
  dayoptEnvironment: process.env.DAYOPT_ENVIRONMENT,
  publicDayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
  vercelEnvironment: process.env.VERCEL_ENV,
  vercelTargetEnvironment: process.env.VERCEL_TARGET_ENV,
  vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
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

    // Edge環境は軽量設定
    // トレースサンプリングを低めに設定（コスト最適化）
    tracesSampler: ({ inheritOrSampleWith }) => inheritOrSampleWith(0.05),

    // デバッグモード無効（Edgeは軽量に）
    debug: false,

    // Production and the explicitly bound Integration project only. Integration
    // also uses Vercel's Production target, so check the Dayopt identity above.
    enabled: SENTRY_ENVIRONMENT !== null,

    // Edge のフィルタリング + PII スクラビング
    beforeSend: withPIIScrub(),
    beforeSendTransaction: scrubSentryTransaction,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}
