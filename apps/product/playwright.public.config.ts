import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { validatePreviewOrigin } from './src/lib/test/preview-access';

const requested = process.env.E2E_PUBLIC_ORIGIN;
const origin =
  requested && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(requested)
    ? requested
    : validatePreviewOrigin(requested);

const config = defineConfig(base, {
  testMatch: 'smoke.spec.ts',
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: 'line',
  use: { baseURL: origin, trace: 'off', video: 'off', screenshot: 'off' },
});
// Public checks only render and navigate; an existing explicit server is required.
delete config.webServer;
export default config;
