import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testerArmyPreviewReporter } from '../../scripts/lib/testerarmy-preview-reporter.mjs';

import { validatePreviewOrigin } from './src/lib/test/preview-access';
import { resolvePreviewCloudUserId } from './src/lib/test/preview-cloud-identity';
import { resolveServiceRoleTarget } from './src/lib/test/service-role-target-guard';

const authenticated = process.env.E2E_PRODUCT_AUTHENTICATED === '1';
const requestedOrigin = process.env.E2E_PRODUCT_ORIGIN;
const localOrigin =
  requestedOrigin && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(requestedOrigin);
const origin =
  localOrigin && !authenticated ? requestedOrigin : validatePreviewOrigin(requestedOrigin);
if (authenticated) {
  if (process.env.E2E_PREVIEW_ORIGIN !== origin) throw new Error('Preview origin mismatch');
  const privateDirectory = process.env.E2E_PREVIEW_PRIVATE_DIR;
  const evidenceDirectory = process.env.E2E_PREVIEW_EVIDENCE_DIR;
  const target = resolveServiceRoleTarget(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
  );
  if (
    !privateDirectory ||
    !evidenceDirectory ||
    !target.safe ||
    process.env.E2E_REQUIRE_SERVICE_ROLE_SUITES !== '1' ||
    process.env.E2E_PREVIEW_CLOUD_INTENT !== '1'
  )
    throw new Error('Authenticated TesterArmy requires the verified staged Preview supervisor');
  const metadata = lstatSync(privateDirectory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    !realpathSync(dirname(fileURLToPath(import.meta.url))).startsWith(
      `${realpathSync(privateDirectory)}/`,
    )
  )
    throw new Error('Authenticated TesterArmy requires a private staged harness');
  const manifest = JSON.parse(
    readFileSync(join(dirname(privateDirectory), 'manifest.json'), 'utf8'),
  );
  if (
    manifest.version !== 1 ||
    manifest.status !== 'running' ||
    manifest.runId !== process.env.E2E_PREVIEW_RUN_ID ||
    manifest.candidate?.origin !== origin ||
    manifest.candidate?.supabaseProjectRef !== process.env.E2E_SUPABASE_PROJECT_REF ||
    manifest.evidenceDirectory !== evidenceDirectory
  )
    throw new Error('Authenticated TesterArmy ownership manifest mismatch');
  resolvePreviewCloudUserId('critical-path');
  resolvePreviewCloudUserId('mobile-critical-path');
}

export default {
  projectId: 'dayopt-product',
  tests: authenticated ? ['testerarmy/journey.e2e.ts'] : ['testerarmy/public.e2e.ts'],
  ...(authenticated
    ? {
        reporters: [testerArmyPreviewReporter(process.env.E2E_PREVIEW_EVIDENCE_DIR!)],
        timeout: 120_000,
        actionTimeout: 15_000,
        assertionTimeout: 15_000,
        cleanupTimeout: 30_000,
      }
    : {}),
  targets: authenticated
    ? [
        {
          name: 'product-authenticated',
          engine: web({
            browser: 'chromium',
            timezoneId: 'Asia/Tokyo',
            locale: 'ja-JP',
            headers: { 'x-dayopt-e2e': 'test' },
          }),
          app: { url: origin },
        },
      ]
    : [
        {
          name: 'product-desktop',
          engine: web({ browser: 'chromium' }),
          app: { url: origin },
        },
        {
          name: 'product-mobile',
          engine: web({ browser: 'chromium', viewport: { width: 390, height: 844 } }),
          app: { url: origin },
        },
      ],
  workers: 1,
  retries: 0,
  trace: 'off',
  video: 'off',
  output: '.e2e',
} satisfies E2EConfig;
