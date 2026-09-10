import { assertProductionSentryBuildEnv, failSentryBuild } from '@dayopt/observability/build-gate';
import bundleAnalyzer from '@next/bundle-analyzer';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

import { assertWebOperationalProductionBuildEnv } from './production-build-gate.mjs';
import { buildWebContentSecurityPolicy } from './security-headers.mjs';

const isVercelProduction = assertProductionSentryBuildEnv(process.env, 'Web');
assertWebOperationalProductionBuildEnv(process.env);

function getSentryIngestOrigin(dsn, name) {
  if (!dsn) return undefined;

  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== 'https:' || !parsed.username) {
      throw new Error('DSN must use HTTPS and include a public key');
    }
    return parsed.origin;
  } catch (error) {
    if (isVercelProduction) {
      throw new Error(`${name} is not a valid Sentry DSN`, { cause: error });
    }
    return undefined;
  }
}

const sentryIngestOrigin = getSentryIngestOrigin(
  process.env.NEXT_PUBLIC_SENTRY_DSN,
  'NEXT_PUBLIC_SENTRY_DSN',
);
getSentryIngestOrigin(process.env.SENTRY_DSN, 'SENTRY_DSN');

const withNextIntl = createNextIntlPlugin('./src/platform/i18n/request.ts');

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Next.js の agent-rules 自動生成を止める（#2693）。理由は
  // apps/product/next.config.mjs の同じ設定に書いてある。web も同じ next を
  // catalog から引くため、`next dev` を agent セッションで起動すれば同様に生成される。
  agentRules: false,

  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || '',
  },

  // セキュリティヘッダー設定
  async headers() {
    // 開発環境では unsafe-eval が必要（Hot Reload用）
    const isDev = process.env.NODE_ENV === 'development';
    const contentSecurityPolicy = buildWebContentSecurityPolicy({
      isDevelopment: isDev,
      sentryIngestOrigin,
    });

    return [
      {
        source: '/(.*)',
        headers: [
          // HSTS（HTTP Strict Transport Security）- MITM攻撃防止
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // CSP（Content Security Policy）
          {
            key: 'Content-Security-Policy',
            value: contentSecurityPolicy,
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
          // XSS対策（レガシーブラウザ用）
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
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

  // 削除・移動した公開ページの 301。
  //
  // **本格公開前は URL 移動の redirect を持たない**（2026-07-27 決定）。まだ外部から
  // 参照されていないため、旧 URL を延命すると設定だけが増える。FAQ を /docs/faq/<slug>
  // へ移した分の 14 エントリはこの方針で入れずに済ませている。
  //
  // 公開後は前提が変わる。被リンクが付いた URL を動かす時は 301 を必ず用意する。
  //
  // 書くのは**実在したページ**だけにする。2026-07-27 の棚卸しで /pricing /features
  // /about /changelog の 8 エントリがページとして一度も存在しなかったことを確認して
  // 削除した（git log --all --diff-filter=A に追加記録が無く、repo 内からのリンクも 0）。
  // 慣習的な URL を先回りして書くと、実際に消したページの方が漏れる。
  //
  // `:locale` は必ず (en|ja) で制約する。無制約の `/:locale/pricing` は 1 セグメントなら
  // 何にでもマッチするため、`/docs/pricing` の `docs` を locale と誤認して公開中の
  // docs ページを食う（2026-07-27 に本番で /docs/features と /docs/pricing が 308 に
  // なっていたのを確認）。locale の正本は @dayopt/config の SUPPORTED_LOCALES。
  async redirects() {
    return [
      // /releases は実在したページ。712668015 でリリースノートを blog の release
      // カテゴリへ統合した際に廃止され、redirect が無いまま本番で 404 になっていた。
      {
        source: '/releases',
        destination: '/blog/release',
        permanent: true,
      },
      {
        source: '/:locale(en|ja)/releases',
        destination: '/:locale/blog/release',
        permanent: true,
      },
      // getting-started の overview は /docs 自体が表示するため、重複コンテンツを避けて寄せる。
      // docs route は dynamicParams: false なのでページ側の redirect() は到達せず、ここで処理する。
      {
        source: '/docs/getting-started',
        destination: '/docs',
        permanent: true,
      },
      {
        source: '/:locale(en|ja)/docs/getting-started',
        destination: '/:locale/docs',
        permanent: true,
      },
    ];
  },

  // Multi-zones設定: LP（web）とアプリ（app）を同一ドメインで運用
  // web側にないパスはapp側（dayopt-app）にフォールバック
  // @see https://nextjs.org/docs/app/building-your-application/deploying/multi-zones
  async rewrites() {
    const appDomain = process.env.APP_DOMAIN || 'https://dayopt-app.vercel.app';

    return {
      // app側のアセットをプロキシ
      beforeFiles: [
        {
          source: '/app-static/:path*',
          destination: `${appDomain}/app-static/:path*`,
        },
      ],
      // web側にないパスをapp側にフォールバック
      fallback: [
        {
          source: '/settings',
          destination: `${appDomain}/settings`,
        },
        {
          source: '/settings/:path*',
          destination: `${appDomain}/settings/:path*`,
        },
        {
          source: '/ja/settings',
          destination: `${appDomain}/ja/settings`,
        },
        {
          source: '/ja/settings/:path*',
          destination: `${appDomain}/ja/settings/:path*`,
        },
      ],
    };
  },

  // ビルド最適化
  compiler: {
    // 本番環境でconsole.log/info/debugを削除、error/warnは残す
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  // Cache Components / PPR（`cacheComponents: true`）は採用しない。2026-09-03 実測（#2519）。
  //
  // PPR は「動的にレンダリングされるページ」を静的シェル + 動的な穴へ分割して TTFB を
  // 縮める仕組みだが、web には動的ページが 1 つも無い:
  // - build の route table は全ページ route が ● (SSG, generateStaticParams)。
  //   ƒ (Dynamic) は /api/* の route handler だけで、これは PPR の対象外
  // - Preview 実測でも /ja, /ja/blog, /ja/blog/[slug], /ja/docs, /ja/docs/faq,
  //   /ja/legal/privacy が全て x-vercel-cache: HIT、TTFB は中央値 80〜91ms
  //
  // 一方コストは実在する。`cacheComponents: true` は route segment config の
  // `runtime` / `revalidate` / `dynamicParams` と非互換で（build が Error で落ちる）、
  // web だけで 15 ファイル・18 宣言を `use cache` + `cacheLife` へ書き換える必要がある。
  // 1h / 1d の revalidate 方針を移し替える回帰テストも今は無い。
  //
  // 便益が測定不能（既に静的配信の下限）でコストが確実に増えるため、現状維持とする。
  // @see https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents

  experimental: {
    // Next.js 15 Router Cache再有効化
    staleTimes: {
      dynamic: 30, // 動的ルート: 30秒キャッシュ
      static: 180, // 静的ルート: 3分キャッシュ
    },
    optimizePackageImports: [
      '@web/components',
      '@web/lib',
      'lucide-react',
      'clsx',
      'class-variance-authority',
    ],
  },

  images: {
    formats: ['image/avif', 'image/webp'], // AVIFを優先（より高圧縮）
    minimumCacheTTL: 2592000, // 30日
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'via.placeholder.com',
        port: '',
        pathname: '/**',
      },
    ],
  },

  poweredByHeader: false,
};

const configuredNext = withNextIntl(withBundleAnalyzer(nextConfig));

const sentryBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  errorHandler: failSentryBuild,
  release: { name: process.env.VERCEL_GIT_COMMIT_SHA },
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  silent: !process.env.CI,
  widenClientFileUpload: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
};

// Preview/CI は runtime 送信も release/source map upload も行わない。
export default isVercelProduction
  ? withSentryConfig(configuredNext, sentryBuildOptions)
  : configuredNext;
