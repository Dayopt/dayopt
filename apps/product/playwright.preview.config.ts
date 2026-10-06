import { defineConfig } from '@playwright/test';

import localConfig from './playwright.config';
import { validatePreviewOrigin } from './src/lib/test/preview-access';
import { resolveServiceRoleTarget } from './src/lib/test/service-role-target-guard';

const origin = validatePreviewOrigin(process.env.E2E_PREVIEW_ORIGIN);
const target = resolveServiceRoleTarget(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);
const projects = localConfig.projects;
if (
  !projects ||
  !target.safe ||
  process.env.E2E_REQUIRE_SERVICE_ROLE_SUITES !== '1' ||
  !process.env.E2E_PREVIEW_PRIVATE_DIR ||
  !process.env.E2E_PREVIEW_EVIDENCE_DIR
) {
  throw new Error('Run Preview E2E through the verified runner');
}

const config = defineConfig(localConfig, {
  testMatch: [
    'critical-path.spec.ts',
    'mobile-critical-path.spec.ts',
    'auth.spec.ts',
    'pwa/pwa.spec.ts',
    'smoke.spec.ts',
    'a11y.spec.ts',
    'account-deletion.spec.ts',
    'calendar-navigation.spec.ts',
    'block-search.spec.ts',
    'plan-record-timeblock.spec.ts',
    'deep-link.spec.ts',
    'derived-plan-record-flow.spec.ts',
    'timeblock-conflict.spec.ts',
    'timeblock-drag-move.spec.ts',
    'timeblock-inspector-toggle.spec.ts',
    'mobile-navigation.spec.ts',
    'billing.spec.ts',
    'calendar-initial-load.spec.ts',
  ],
  // Only reviewed, tagged declarations enter the remote lane. Desktop/mobile
  // fixtures reuse their two IDs sequentially; account deletion gets its own ID.
  // Mobile also requires @mobile.
  projects: projects.map((project) => ({
    ...project,
    grep: project.name === 'Mobile Chrome' ? /(?=.*@mobile)(?=.*@preview-e2e\/)/ : /@preview-e2e\//,
  })),
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
