import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const externalURL = process.env.WEB_E2E_BASE_URL;
const baseURL = externalURL || 'http://localhost:3001';

export default defineConfig({
  testDir: './src/test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  timeout: 45 * 1000,
  expect: {
    timeout: 15000,
  },
  // The existing promotion job consumes JSON/JUnit; local runs retain no report in the repo.
  reporter: process.env.CI
    ? [
        ['html'],
        ['json', { outputFile: 'test-results/e2e-results.json' }],
        ['junit', { outputFile: 'test-results/e2e-results.xml' }],
      ]
    : [['line']],
  outputDir: process.env.CI ? 'test-results' : join(tmpdir(), 'dayopt-web-playwright'),
  use: {
    baseURL,
    actionTimeout: 15 * 1000,
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'Mobile Chrome',
      grep: /@mobile/,
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: externalURL
    ? undefined
    : {
        // CI では build を含めない。ci.yml の web job が直前 step で `pnpm build:web` を
        // 実行済みで、ここに build を書くと同一 job 内で next build が二重に走る
        // （実測で発覚、2026-08-05）。build 無しで起動した場合は next start が
        // .next 不在で即 fail するので、壊れ方は「静かに古い build を使う」ではなく明示的。
        command: process.env.CI ? 'pnpm start:e2e' : 'pnpm dev:e2e',
        env: {
          NEXT_PUBLIC_SENTRY_DSN: '',
          SENTRY_DSN: '',
          NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED: 'false',
          NEXT_PUBLIC_POSTHOG_PROJECT_KEY: '',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
          TURNSTILE_SECRET_KEY: '',
          RESEND_API_KEY: '',
          RESEND_FROM_EMAIL: '',
          RESEND_WEBHOOK_SECRET: '',
          VERCEL_ENV: '',
        },
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        timeout: (process.env.CI ? 240 : 120) * 1000,
      },
});
