import { assertProductionSentryBuildEnv, failSentryBuild } from '@dayopt/observability/build-gate';
import bundleAnalyzer from '@next/bundle-analyzer';
import nextEnv from '@next/env';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';
import { fileURLToPath } from 'url';

import {
  assertProductOperationalProductionBuildEnv,
  assertProductPreviewBuildEnv,
  resolveProductPublicMcpResourceUri,
} from './production-build-gate.mjs';
import { releaseVersion } from './release-version.mjs';

const { loadEnvConfig } = nextEnv;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
loadEnvConfig(repoRoot);

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

assertProductPreviewBuildEnv(process.env);
const isSentryProductionBuild = assertProductionSentryBuildEnv(process.env, 'Product');
assertProductOperationalProductionBuildEnv(process.env);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Next.js の agent-rules 自動生成を止める（#2693）。
  //
  // Next.js 16 は `next dev` が AI coding agent を検出すると、この app ディレクトリへ
  // `AGENTS.md` / `CLAUDE.md`（`<!-- BEGIN:nextjs-agent-rules -->` ブロック）を書き出す。
  // Dayopt では 2 つの実害がある:
  //   1. untracked のまま残り、`pnpm branch:finish` の worktree dirty 判定
  //      （scripts/tasks/finish-branch.sh の `git status --porcelain`）が毎回止まる
  //   2. 誰も書いていない指示ファイルが指示として読み込まれる。repo が意図して置いた
  //      nested な AGENTS.md（apps/product/src/AGENTS.md 等）とは別物で、内容は
  //      next の version 次第。provider や framework が書いた指示を正本へ逆流させない
  //      （docs/operations/tooling.md）
  // env での無効化手段は無く、この top-level flag が唯一の opt-out。
  agentRules: false,

  // Multi-zones設定: LP（web）とアプリ（app）を同一ドメインで運用
  // @see https://nextjs.org/docs/app/building-your-application/deploying/multi-zones
  assetPrefix: process.env.NODE_ENV === 'production' ? '/app-static' : undefined,

  // セキュリティ: X-Powered-By ヘッダーを削除（サーバー情報漏洩防止）
  poweredByHeader: false,

  // 環境変数設定
  env: {
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'placeholder',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '',
    NEXT_PUBLIC_APP_VERSION: releaseVersion,
    NEXT_PUBLIC_MCP_RESOURCE_URI: resolveProductPublicMcpResourceUri(process.env),
    // client 側で Vercel 環境を判別するため露出。preview は NODE_ENV=production だが
    // VERCEL_ENV=preview なので、Sentry を production のみ有効化する gate に必要。
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || '',
    // sw.js のキャッシュバージョニング（useServiceWorker.ts が `/sw.js?v=<sha>` で登録する）
    // に使う。turbo.json の build env allowlist には VERCEL_GIT_COMMIT_SHA はあるが
    // NEXT_PUBLIC_ 版が無いため、ここで client 向けに再露出する。
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
  },

  // TypeScript設定
  typescript: {
    ignoreBuildErrors: false,
  },

  // Multi-zones用リライト設定
  // assetPrefixで設定したパスを実際の_nextパスにリライト
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/app-static/_next/:path*',
          destination: '/_next/:path*',
        },
      ],
    };
  },

  // セキュリティヘッダー設定
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // HSTS（HTTP Strict Transport Security）- MITM攻撃防止
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // Clickjacking対策
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          // MIME type sniffing防止
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          // XSS対策: CSPに完全移行のため無効化（'1; mode=block'はChrome 78+で削除済み、
          // 一部ケースでバイパスに利用される可能性があるためMDN推奨に従い0に設定）
          {
            key: 'X-XSS-Protection',
            value: '0',
          },
          // リファラー情報制御
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          // ブラウザAPI使用制限
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      // 静的ファイルのキャッシュ設定
      {
        source: '/robots.txt',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
          },
        ],
      },
      {
        source: '/sitemap.xml',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
          },
        ],
      },
      {
        source: '/favicon.ico',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      // アイコン・マニフェスト（1日キャッシュ + 再検証）
      //
      // immutable にしない。immutable が正しいのは内容ハッシュを URL に持つ
      // アセット（上の _next/static）だけで、これらは URL が固定のまま中身が
      // 変わりうる。ブランド変更でアイコンのバイト列と manifest の色を差し替えた
      // 時（#1757）、immutable だと既存訪問者に最大 1 年間旧ブランドが残る。
      {
        source: '/:path(icons/icon-*.png|icons/apple-touch-icon.png|manifest.json)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, must-revalidate',
          },
        ],
      },
      // OG画像（1ヶ月キャッシュ）
      {
        source: '/og-image.png',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=86400',
          },
        ],
      },
      // フォントファイル（1年キャッシュ）
      {
        source: '/:path*.woff2',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },

  // 画像最適化設定
  // Vercelデプロイ時はVercel側で画像最適化が行われるためsharp不要
  // ローカル開発時はomit=optional(.npmrc)によりsharpをスキップ
  images: {
    formats: ['image/avif', 'image/webp'], // AVIFを優先（より高圧縮）
    minimumCacheTTL: 2592000, // 30日（画像は変更頻度が低い）
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'yvglwblxrnrenfifsnje.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  // 実験的機能
  experimental: {
    // React Compiler: 現在無効化
    // next-intlのコンテキスト伝播と干渉するため、互換性が解決されるまで無効化
    // @see https://github.com/amannn/next-intl/issues
    // reactCompiler: true,

    // Partial Prerendering（PPR）/ Cache Components - 採用しない
    //
    // Next.js 16 では `cacheComponents: true` で stable 利用できるようになったため、
    // 2026-09-03 に web 起点で評価した（#2519）。結論は「web では採用しない」。
    // Product は「web で便益が確認できた場合のみ評価する」という条件付きだったので、
    // 前提が満たされず未評価のまま据え置く。
    //
    // web で採用しなかった理由（実測）:
    // - web の全ページ route は既に ● (SSG)。実測でも x-vercel-cache: HIT / TTFB
    //   64〜91ms で、サーバレンダリングが 1 度も発生していない。PPR が削る時間が無い
    // - `cacheComponents: true` は route segment config の `runtime` / `revalidate` /
    //   `dynamicParams` と非互換で、web だけで 15 ファイル・18 宣言の書き換えが要る
    //
    // Product を評価するなら前提が web と違う点に注意する。認証済みユーザーデータが
    // 中心で、共有キャッシュへ載せてよい領域を先に切り分ける必要がある（#2516 の
    // Supabase SSR cache-header / refresh-cookie continuity と競合させない）。
    // @see https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents

    // Next.js 15 Router Cache再有効化（デフォルトで無効化された）
    // ページ遷移パフォーマンス向上のため、クライアント側キャッシュを有効化
    // @see https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes
    staleTimes: {
      dynamic: 30, // 動的ルート: 30秒キャッシュ（[locale]等）
      static: 180, // 静的ルート: 3分キャッシュ
    },
    optimizePackageImports: [
      // アイコン
      'lucide-react',
      '@radix-ui/react-icons',
      // Radix UI コンポーネント
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toggle',
      '@radix-ui/react-tooltip',
      // ユーティリティ
      'date-fns',
      'motion',
      'clsx',
      'class-variance-authority',
    ],
  },

  // ビルド最適化
  compiler: {
    // GAFAベストプラクティス: 本番環境でconsole.log/info/debugを削除
    // error/warnは残す（エラー監視のため）
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
};

/**
 * Sentry設定オプション
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */
const sentryOptions = {
  // ソースマップアップロード（ビルド時）
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  errorHandler: failSentryBuild,

  // Production gateが必須化したcommit SHAをrelease/source mapで共通利用する。
  release: { name: process.env.VERCEL_GIT_COMMIT_SHA },

  // ソースマップ設定
  sourcemaps: {
    // ソースマップを自動削除（本番環境でソースコード露出防止）
    deleteSourcemapsAfterUpload: true,
  },

  // ビルドログ制御
  silent: !process.env.CI, // CI環境以外ではログを抑制

  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },

  // パフォーマンス最適化
  widenClientFileUpload: true, // クライアントファイルのアップロード範囲拡大

  // NOTE: tunnelRouteは削除済み - CSPヘッダーでSentryドメインを許可しているため不要
  // tunnelRoute有効時、ルートハンドラーが自動生成されない問題でイベントが失われていた
};

const configuredNext = withBundleAnalyzer(withNextIntl(nextConfig));

// Preview/local builds do not create empty Sentry releases or upload source maps.
export default isSentryProductionBuild
  ? withSentryConfig(configuredNext, sentryOptions)
  : configuredNext;
