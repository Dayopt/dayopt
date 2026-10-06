import { defineConfig } from '@playwright/test';
import base from './playwright.config';
// Protected remote Preview acceptance uses playwright.preview.config.ts and its trusted runner.
const requested = process.env.E2E_PUBLIC_ORIGIN;
if (!requested) throw new Error('Public checks require an explicit running loopback app origin');
const url = new URL(requested);
if (
  url.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('Public checks app origin must be an HTTP loopback origin');
const origin = url.origin;

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
