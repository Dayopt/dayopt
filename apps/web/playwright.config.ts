import { defineConfig, devices } from '@playwright/test';

const externalBaseURL = process.env.WEB_E2E_BASE_URL;

export default defineConfig({
  testDir: './src/test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  timeout: 30 * 1000,
  expect: {
    timeout: 5000,
  },
  reporter: process.env.CI
    ? [
        ['html'],
        ['json', { outputFile: 'test-results/e2e-results.json' }],
        ['junit', { outputFile: 'test-results/e2e-results.xml' }],
      ]
    : [['html']],
  use: {
    baseURL: externalBaseURL || 'http://localhost:3001',
    actionTimeout: 10 * 1000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome'],
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        // CI では build を含めない。ci.yml の web job が直前 step で `pnpm build:web` を
        // 実行済みで、ここに build を書くと同一 job 内で next build が二重に走る
        // （実測で発覚、2026-08-05）。build 無しで起動した場合は next start が
        // .next 不在で即 fail するので、壊れ方は「静かに古い build を使う」ではなく明示的。
        command: process.env.CI ? 'pnpm start:e2e' : 'pnpm dev:e2e',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        timeout: (process.env.CI ? 240 : 120) * 1000,
      },
});
