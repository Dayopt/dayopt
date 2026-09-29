import { defineConfig, devices } from '@playwright/test';

import localConfig from './playwright.config';
import { validatePreviewOrigin } from './src/lib/test/preview-access';
import {
  loadPreviewFixtureRegistry,
  resolveCriticalPathTarget,
} from './src/lib/test/preview-fixture-registry';

const origin = validatePreviewOrigin(process.env.E2E_PREVIEW_ORIGIN);
const registry = loadPreviewFixtureRegistry();
const target = resolveCriticalPathTarget();
if (
  !target.safe ||
  process.env.E2E_REQUIRE_SERVICE_ROLE_SUITES !== '1' ||
  !process.env.E2E_PREVIEW_PRIVATE_DIR ||
  !process.env.E2E_PREVIEW_EVIDENCE_DIR
) {
  throw new Error('Run Preview E2E through the verified runner');
}

const config = defineConfig(localConfig, {
  ...(registry
    ? {
        projects: [
          {
            name: 'chromium',
            testMatch: 'critical-path.spec.ts',
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1920, height: 1080 },
            },
          },
          {
            name: 'Mobile Chrome',
            testMatch: 'mobile-critical-path.spec.ts',
            dependencies: ['chromium'],
            use: { ...devices['Pixel 5'] },
          },
          {
            name: 'preview-authorization',
            testMatch: 'preview-authorization.spec.ts',
            dependencies: ['Mobile Chrome'],
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1920, height: 1080 },
            },
          },
        ],
      }
    : {}),
  testMatch: [
    'critical-path.spec.ts',
    'mobile-critical-path.spec.ts',
    'preview-authorization.spec.ts',
  ],
  retries: 0,
  globalTimeout: 5 * 60 * 1000,
  workers: 1,
  forbidOnly: true,
  outputDir: process.env.E2E_PREVIEW_PRIVATE_DIR,
  reporter: [
    [
      '../../scripts/lib/preview-e2e-reporter.mjs',
      { directory: process.env.E2E_PREVIEW_EVIDENCE_DIR },
    ],
  ],
  use: {
    baseURL: origin,
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
// The remote runner never builds or starts the local application.
delete config.webServer;
export default config;
