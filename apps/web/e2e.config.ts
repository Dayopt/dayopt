import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

const url = process.env.TESTERARMY_WEB_URL;
if (!url)
  throw new Error('Set TESTERARMY_WEB_URL to the web Preview URL or an explicit local server.');

export default {
  projectId: 'dayopt-web',
  tests: ['testerarmy/**/*.e2e.ts'],
  workers: 1,
  retries: 0,
  timeout: 45_000,
  actionTimeout: 15_000,
  assertionTimeout: 15_000,
  targets: [
    { name: 'desktop', engine: web({ viewport: { width: 1440, height: 1000 } }), app: { url } },
    { name: 'mobile', engine: web({ viewport: { width: 390, height: 844 } }), app: { url } },
  ],
} satisfies E2EConfig;
