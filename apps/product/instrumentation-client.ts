/**
 * Sentry クライアントサイド設定
 *
 * ブラウザでのエラー監視・パフォーマンス監視を設定。
 * Next.js 15では自動的に読み込まれます。
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  isBrowserTelemetryConsentStorageChange,
  resolveAnalyticsConsentDetail,
} from '@dayopt/observability';
import * as Sentry from '@sentry/nextjs';

import { resolveDayoptEnvironment } from '@/lib/dayopt-environment';
import {
  scrubSentryBreadcrumb,
  scrubSentrySpan,
  scrubSentryTransaction,
  withPIIScrub,
} from '@/lib/sentry/scrub-pii';

// ナビゲーション計測用フック（Sentry SDK が要求）
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const VERCEL_ENV = process.env.NEXT_PUBLIC_VERCEL_ENV;
// Keep a build-time condition so ordinary Preview bundles omit Sentry initialization.
// The resolved binding below still decides whether this deployment owns telemetry.
const IS_SENTRY_DEPLOYMENT =
  VERCEL_ENV === 'production' || process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT === 'integration';
const DAYOPT_ENVIRONMENT = resolveDayoptEnvironment({
  dayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
  publicDayoptEnvironment: process.env.NEXT_PUBLIC_DAYOPT_ENVIRONMENT,
  vercelEnvironment: VERCEL_ENV,
  vercelTargetEnvironment: process.env.NEXT_PUBLIC_VERCEL_TARGET_ENV,
  vercelGitCommitRef: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF,
  vercelProjectId: process.env.NEXT_PUBLIC_VERCEL_PROJECT_ID,
  vercelBranchUrl: process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL,
  vercelUrl: process.env.NEXT_PUBLIC_VERCEL_URL,
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
});
const SENTRY_ENVIRONMENT =
  DAYOPT_ENVIRONMENT === 'production' || DAYOPT_ENVIRONMENT === 'integration'
    ? DAYOPT_ENVIRONMENT
    : null;
let isSentryInitialized = false;
let isBrowserTelemetryAllowed = false;
let revocationReloadRequested = false;

function hasStoredAnalyticsConsent(): boolean {
  return hasAnalyticsConsent(getBrowserTelemetryConsentStorage());
}

function setSentryClientEnabled(enabled: boolean): void {
  const client = Sentry.getClient();
  if (client) client.getOptions().enabled = enabled;
}

/**
 * 分析への同意がある間だけSentryを初期化する。
 */
function initSentry(dsn: string) {
  if (isSentryInitialized || !isBrowserTelemetryAllowed || !hasStoredAnalyticsConsent()) return;
  isSentryInitialized = true;

  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT ?? 'unknown',
    sendDefaultPii: false,
    // release は withSentryConfig が build 時に注入する（next.config の release.name = VERCEL_GIT_COMMIT_SHA）。
    // ここで明示すると source map upload 時の release と runtime がズレるため上書きしない。

    tracesSampler: ({ inheritOrSampleWith }) => inheritOrSampleWith(0.1),

    // デバッグモード（開発環境のみ）
    debug: false,

    // Only Production or the fully bound fixed Integration can send telemetry.
    enabled: IS_SENTRY_DEPLOYMENT && SENTRY_ENVIRONMENT !== null,

    // 固定protocol allowlistとpath-aware規則で、相関IDを保持しつつPIIを除去する。
    beforeSend: withPIIScrub(),
    beforeSendTransaction: scrubSentryTransaction,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,

    // クライアントサイド用インテグレーション
    integrations: [
      // パフォーマンス監視（INP計測含む）
      Sentry.browserTracingIntegration({
        enableInp: true,
      }),
    ],
  });

  // プラットフォームタグ: PWA（standalone）か通常ブラウザかを識別
  if (typeof window !== 'undefined') {
    const isPwa = window.matchMedia('(display-mode: standalone)').matches;
    Sentry.setTag('app.platform', isPwa ? 'pwa' : 'web');
  }
}

function applyBrowserTelemetryConsent(dsn: string, allowed: boolean): void {
  isBrowserTelemetryAllowed = allowed && hasStoredAnalyticsConsent();

  if (!isBrowserTelemetryAllowed) {
    setSentryClientEnabled(false);
    if (isSentryInitialized && !revocationReloadRequested) {
      revocationReloadRequested = true;
      try {
        window.location.reload();
      } catch {
        // The client stays disabled and cannot be re-enabled in this document.
      }
    }
    return;
  }

  if (revocationReloadRequested) return;

  if (isSentryInitialized) {
    setSentryClientEnabled(true);
  } else {
    initSentry(dsn);
  }
}

// DSNが設定されている場合のみ処理
if (SENTRY_DSN && IS_SENTRY_DEPLOYMENT && SENTRY_ENVIRONMENT !== null) {
  isBrowserTelemetryAllowed = typeof window !== 'undefined' && hasStoredAnalyticsConsent();

  if (isBrowserTelemetryAllowed) {
    // 同意済み: 即座に初期化
    initSentry(SENTRY_DSN);
  }

  if (typeof window !== 'undefined') {
    // 同意の付与・撤回をアプリ実行中も監視する
    const dsn = SENTRY_DSN;
    const handler = (event: Event) => {
      const analyticsConsent = resolveAnalyticsConsentDetail(
        (event as CustomEvent<unknown>).detail,
      );
      if (analyticsConsent === null) return;

      applyBrowserTelemetryConsent(dsn, analyticsConsent);
    };
    const handleStorage = (event: StorageEvent) => {
      if (!isBrowserTelemetryConsentStorageChange(event.key)) return;
      applyBrowserTelemetryConsent(dsn, hasStoredAnalyticsConsent());
    };
    window.addEventListener(BROWSER_TELEMETRY_CONSENT_EVENT, handler);
    window.addEventListener('storage', handleStorage);
  }
}
