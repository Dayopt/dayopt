import { defineConfig } from '@playwright/test';

import base from './playwright.config';

const origin = process.env.E2E_AUTH_LIFECYCLE_ORIGIN;
if (!origin) throw new Error('Auth lifecycle requires an explicit running loopback app origin');
const url = new URL(origin);
if (
  url.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('Auth lifecycle app origin must be an HTTP loopback origin');

const config = defineConfig(base, {
  testMatch: ['auth-lifecycle.manual.ts'],
  projects: (base.projects ?? []).filter((project) => project.name === 'chromium'),
  workers: 1,
  retries: 0,
  reporter: [['line']],
  use: { baseURL: url.origin, trace: 'off', video: 'off', screenshot: 'off' },
});
// The operator must prepare an isolated target and sink; this config starts neither.
delete config.webServer;
export default config;
