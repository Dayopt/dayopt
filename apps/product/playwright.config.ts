import { defineConfig, devices } from '@playwright/test';

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './src/lib/test/e2e',

  // テストの並列実行
  fullyParallel: true,

  // CI環境でのfail時にワーカーを停止しない
  forbidOnly: !!process.env.CI,

  // テスト失敗時のリトライ
  retries: process.env.CI ? 2 : 0,

  // 並列ワーカー数（GitHub Actions ubuntu-latest: 2 vCPU）
  ...(process.env.CI ? { workers: 2 } : {}),

  // タイムアウト設定
  timeout: 30 * 1000, // テスト全体: 30秒
  expect: {
    timeout: 5000, // アサーション: 5秒
  },

  // レポーター設定（JSON/JUnitはCI専用）
  reporter: process.env.CI
    ? [
        ['html'],
        ['json', { outputFile: 'test-results/e2e-results.json' }],
        ['junit', { outputFile: 'test-results/e2e-results.xml' }],
      ]
    : [['html']],

  // テスト実行設定
  use: {
    // ベースURL
    baseURL: 'http://localhost:3000',

    // アクションタイムアウト（クリック、入力等）
    actionTimeout: 10 * 1000,

    // トレース設定（失敗時のみ）
    trace: 'on-first-retry',

    // スクリーンショット設定
    screenshot: 'only-on-failure',

    // ビデオ録画設定
    video: 'retain-on-failure',
  },

  // chromium は全 spec、Mobile Chrome は `@mobile` tag の test だけを持つ（#2743）。
  // 全 spec を mobile で二重実行せず、mobile 固有の操作境界（長押し作成・Drawer・
  // ヘッダーナビ）を通す test だけを CI（promote.yml 層 3）で同じ invocation に入れる。
  // 方針の正本は docs/engineering/testing.md。
  projects: [
    // ==========================================
    // デスクトップ（Chromiumのみ）
    // ==========================================
    {
      name: 'chromium',
      grepInvert: /@mobile/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // ==========================================
    // モバイル（Chromeのみ）
    // ==========================================
    {
      name: 'Mobile Chrome',
      grep: /@mobile/,
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],

  // サーバー起動設定
  // CI: 本番ビルドを起動する。next dev はルートを初回アクセス時に遅延コンパイルするため、
  //     2 vCPU ランナーで冷間コンパイルが actionTimeout(10s) を超えて flaky になる。
  //     事前ビルド済みを叩くことで初回 timeout を構造的に排除する。
  // ローカル: 速い反復のため dev サーバーを維持。
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev:raw',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    // CI は build(~90s)+start を吸収するため延長。
    timeout: (process.env.CI ? 240 : 120) * 1000,
  },
});
