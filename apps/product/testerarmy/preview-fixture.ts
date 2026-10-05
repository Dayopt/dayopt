import { type Browser } from '@e2e-dev/web';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forwardPreviewRequest } from '../../../scripts/runbook/testerarmy-preview-e2e.mjs';
import { validatePreviewOrigin } from '../src/lib/test/preview-access';

let current:
  { browser: Browser; network: Array<{ at: number; target: string; status: number }> } | undefined;

export async function installTesterArmyPreviewFence(browser: Browser) {
  const origin = validatePreviewOrigin(process.env.E2E_PREVIEW_ORIGIN);
  const supabaseRef = process.env.E2E_SUPABASE_PROJECT_REF;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const privateDirectory = process.env.E2E_PREVIEW_PRIVATE_DIR;
  if (!supabaseRef || !/^[a-z]{20}$/.test(supabaseRef) || !bypassSecret || !privateDirectory)
    throw new Error('Verified Preview fence prerequisites are missing');
  const network: Array<{ at: number; target: string; status: number }> = [];
  current = { browser, network };
  let reserved = 0;
  await browser.route('**/*', async (route) => {
    if (reserved++ >= 2000) {
      await route.abort();
      throw new Error('Preview network evidence limit exceeded');
    }
    await forwardPreviewRequest({
      route,
      browser,
      origin,
      supabaseRef,
      bypassSecret,
      privateDirectory,
      network,
    });
  });
}

export async function finishTesterArmyPreviewFence() {
  if (!current || !process.env.E2E_PREVIEW_EVIDENCE_DIR)
    throw new Error('Preview evidence prerequisites are missing');
  const directory = join(process.env.E2E_PREVIEW_EVIDENCE_DIR, 'network');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${crypto.randomUUID()}.json`), JSON.stringify(current.network), {
    mode: 0o600,
  });
  current = undefined;
}
