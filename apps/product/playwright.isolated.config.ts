import { defineConfig } from '@playwright/test';

import localConfig from './playwright.config';
import { resolveIsolatedServiceRoleTarget } from './src/lib/test/isolated-service-role-target';

const target = resolveIsolatedServiceRoleTarget(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);
if (!target.safe || process.env.CI !== '1' || process.env.POSTHOG_SERVER_ENABLED !== 'false') {
  throw new Error(
    'Isolated E2E requires CI=1, a local Supabase target, and disabled server telemetry',
  );
}
// Public declarations select the local browser fence before workers collect specs.
process.env.E2E_ISOLATED_RUN = '1';

export default defineConfig({
  ...localConfig,
  testMatch: [
    'calendar-navigation.spec.ts',
    'record-lifecycle.spec.ts',
    'http-csrf.spec.ts',
    'pwa/pwa.spec.ts',
    'consent-ical.spec.ts',
  ],
  projects: localConfig.projects!.filter((project) => project.name === 'chromium'),
  workers: 1,
  retries: 0,
  reporter: [['line']],
  outputDir: process.env.E2E_ISOLATED_ARTIFACT_DIR ?? '/tmp/dayopt-product-isolated-e2e',
  use: {
    ...localConfig.use,
    serviceWorkers: 'allow',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    ...localConfig.webServer!,
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    timeout: 240_000,
    reuseExistingServer: false,
    env: { POSTHOG_SERVER_ENABLED: 'false', NEXT_PUBLIC_POSTHOG_PROJECT_KEY: '' },
  },
});
