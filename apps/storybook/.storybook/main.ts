// This file has been automatically migrated to valid ESM format by Storybook.
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'path';

import type { StorybookConfig } from '@storybook/nextjs-vite';
import tailwindcss from '@tailwindcss/vite';
import remarkGfm from 'remark-gfm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config: StorybookConfig = {
  stories: [
    '../../product/src/**/*.mdx',
    '../../product/src/**/*.stories.@(js|jsx|mjs|ts|tsx)',
    // Web layer（apps/web）— 現状は Web/Overview のみ。今後 component/section/page story を追加する受け皿
    '../../web/src/**/*.mdx',
    '../../web/src/**/*.stories.@(js|jsx|mjs|ts|tsx)',
    '../../../packages/foundations/src/**/*.mdx',
    '../../../packages/foundations/src/**/*.stories.@(js|jsx|mjs|ts|tsx)',
    '../../../packages/components/src/**/*.mdx',
    '../../../packages/components/src/**/*.stories.@(js|jsx|mjs|ts|tsx)',
    './stories/**/*.stories.@(js|jsx|mjs|ts|tsx)',
  ],
  addons: [
    '@storybook/addon-a11y',
    '@vueless/storybook-dark-mode',
    '@storybook/addon-vitest',
    {
      name: '@storybook/addon-docs',
      options: {
        mdxPluginOptions: {
          mdxCompileOptions: {
            remarkPlugins: [remarkGfm],
          },
        },
      },
    },
    {
      name: '@storybook/addon-mcp',
      options: {
        toolsets: {
          dev: true,
          docs: true,
        },
      },
    },
  ],
  framework: {
    name: '@storybook/nextjs-vite',
    options: {},
  },
  // async Server Component（apps/web の marketing セクション等）を Suspense でラップして描画
  features: {
    experimentalRSC: true,
  },
  staticDirs: ['../../product/public'],
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
  core: {
    disableTelemetry: true,
  },
  previewHead: (head) => `
    ${head}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@200..900&family=Noto+Sans+JP:wght@100..900&display=swap"
      rel="stylesheet"
    />
    <style>
      /* next/font を通らない環境なので、product 側の変数名に合わせて手動定義する。
         product の variable 名を変えた時はここも必ず同時に直す（黙ってシステムフォントに落ちる）。
         generic family は入れない。stack 上で和文フォントより前に来てしまうため
         （不変条件は foundations の tokens/typography.css に記載）。 */
      :root {
        --font-latin: 'Source Sans 3';
        --font-noto-jp: 'Noto Sans JP';
      }
    </style>
    <script>
      document.documentElement.setAttribute('lang', 'ja');
    </script>
  `,
  managerHead: (head) => `
    ${head}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@200..900&family=Noto+Sans+JP:wght@100..900&display=swap"
      rel="stylesheet"
    />
    <script>
      document.documentElement.setAttribute('lang', 'ja');
    </script>
  `,
  viteFinal: async (config) => {
    // パスエイリアス設定
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      // '@' は product/src、'@web' は web/src。prefix が別なので product との衝突や
      // Vite alias の順序依存は発生しない（#1499: apps/web の import alias を '@/' から
      // '@web/' へ変更し、per-path whitelist を撤廃した）。
      '@web': path.resolve(__dirname, '../../web/src'),
      '@': path.resolve(__dirname, '../../product/src'),
      '@dayopt/storybook': path.resolve(__dirname),
      // next-intl（React未定義エラー回避）— next/image, next/link, next/navigation は @storybook/nextjs-vite が自動解決
      'next-intl/navigation': path.resolve(__dirname, './mocks/next-intl-navigation.tsx'),
      'next-intl/routing': path.resolve(__dirname, './mocks/next-intl-routing.ts'),
      // next-intl/server（getTranslations / setRequestLocale）— apps/web の async Server Component セクションを
      // Storybook で描画するため。request scope を持たない Storybook では web messages から同期解決する
      'next-intl/server': path.resolve(__dirname, './mocks/next-intl-server.tsx'),
      // Sentry（@sentry/nextjs が Next.js 内部の process 依存のため Storybook ではモック化）
      '@sentry/nextjs': path.resolve(__dirname, './mocks/sentry-nextjs.ts'),
      // Storybook 10: @storybook/blocks は @storybook/addon-docs/blocks に統合
      '@storybook/blocks': '@storybook/addon-docs/blocks',
    };
    // サーバー専用モジュール（crypto等）をブラウザバンドルから除外
    config.build = {
      ...config.build,
      rollupOptions: {
        ...config.build?.rollupOptions,
        external: [...((config.build?.rollupOptions?.external as string[]) || []), 'crypto'],
      },
    };
    // Supabase client の env ガード用ダミー値。
    // createClient() は env 未設定 / placeholder 値で SupabaseConfigError を投げるため、
    // これが無いと Auth client に触れる component（AccountSettings 等）が Storybook で描画できない。
    // Storybook から実 API は叩かないので、疎通しない値で構わない（placeholder とは別の値にする）。
    config.define = {
      ...config.define,
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify('https://storybook.supabase.co'),
      'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('storybook-anon-key'),
      // McpApiSection は deploy ごとの resource URI が空だと接続導線を出さない。
      // Storybook では production 相当の値を与えてセクションを描画する。
      'process.env.NEXT_PUBLIC_MCP_RESOURCE_URI': JSON.stringify('https://mcp.dayopt.app'),
    };
    // React自動JSXランタイム設定
    config.esbuild = {
      ...config.esbuild,
      jsx: 'automatic',
    };
    // Tailwind CSS v4: Viteプラグインで @import チェーンを正しく処理
    // PostCSS の @tailwindcss/postcss と競合するため、Vite側で上書き
    config.plugins = [...(config.plugins || []), tailwindcss()];
    config.css = {
      ...config.css,
      postcss: { plugins: [] },
    };
    return config;
  },
};

export default config;
