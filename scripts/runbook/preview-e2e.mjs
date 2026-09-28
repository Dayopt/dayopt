#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedMigrationVersions } from '../ci/production-migration-readiness.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { isPassingPreviewReport } from '../lib/preview-e2e-reporter.mjs';
import { recoverPreviewUsers } from './preview-cleanup.mjs';
import { observePreviewReadiness, parsePreviewReadinessArgs } from './preview-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function previewWorkerEnvironment(
  env,
  ready,
  privateDir,
  evidenceDir,
  runId,
  cloudUserIds = /** @type {{desktop: string, mobile: string} | undefined} */ (undefined),
) {
  const result = { NODE_ENV: 'test', CI: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (env[key]) result[key] = env[key];
  }
  return {
    ...result,
    NEXT_PUBLIC_SUPABASE_URL: `https://${ready.supabaseProjectRef}.supabase.co`,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    VERCEL_AUTOMATION_BYPASS_SECRET: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    E2E_ALLOW_NONLOCAL_SUPABASE: '1',
    E2E_REQUIRE_SERVICE_ROLE_SUITES: '1',
    E2E_SUPABASE_PROJECT_REF: ready.supabaseProjectRef,
    E2E_PREVIEW_ORIGIN: ready.origin,
    E2E_PREVIEW_RUN_ID: runId,
    E2E_PREVIEW_PRIVATE_DIR: privateDir,
    E2E_PREVIEW_EVIDENCE_DIR: evidenceDir,
    ...(cloudUserIds
      ? {
          E2E_PREVIEW_CLOUD_INTENT: '1',
          E2E_PREVIEW_DESKTOP_USER_ID: cloudUserIds.desktop,
          E2E_PREVIEW_MOBILE_USER_ID: cloudUserIds.mobile,
        }
      : {}),
  };
}

/** @returns {Promise<number>} */
function executePlaywright(env, candidateRoot = ROOT) {
  // Cloud runners and the optional Mac path are POSIX. Own the process group so
  // a deadline cannot leave browsers running after private output is removed.
  return new Promise((resolveExit) => {
    const child = spawn(
      'pnpm',
      [
        '--dir',
        'apps/product',
        'exec',
        'playwright',
        'test',
        '--config',
        'playwright.preview.config.ts',
      ],
      {
        cwd: candidateRoot,
        env,
        stdio: 'ignore',
        detached: true,
      },
    );
    let timedOut = false;
    const deadline = setTimeout(
      () => {
        timedOut = true;
        const kill = (signal) => {
          try {
            if (child.pid) process.kill(-child.pid, signal);
          } catch {
            /* group already exited */
          }
        };
        kill('SIGTERM');
        setTimeout(() => {
          kill('SIGKILL');
          resolveExit(1);
        }, 3000);
      },
      7 * 60 * 1000,
    );
    child.on('error', () => {
      clearTimeout(deadline);
      resolveExit(1);
    });
    child.on('exit', (code) => {
      if (!timedOut) {
        clearTimeout(deadline);
        resolveExit(code ?? 1);
      }
    });
  });
}

/** The injected executor/readiness are test seams; the CLI always uses live implementations. */
export async function runPreviewE2E({
  request,
  env = process.env,
  observe = observePreviewReadiness,
  candidateRoot = ROOT,
  execute = (workerEnv) => executePlaywright(workerEnv, candidateRoot),
  recover = recoverPreviewUsers,
  tempRoot = tmpdir(),
  runDirectory = /** @type {string | undefined} */ (undefined),
  runId = randomUUID(),
  cloudUserIds = /** @type {{desktop: string, mobile: string} | undefined} */ (undefined),
}) {
  if (!env.SUPABASE_SECRET_KEY?.trim())
    throw new Error('Nonproduction test credentials are required');
  const credentials = {
    vercelToken: env.VERCEL_TOKEN,
    supabaseToken: env.SUPABASE_PREVIEW_READINESS_TOKEN,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
  };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId))
    throw new Error('Preview run identity is invalid');
  const before = await observe({ ...request, ...credentials });
  const directory = runDirectory ?? mkdtempSync(join(tempRoot, 'dayopt-preview-e2e-'));
  if (runDirectory) mkdirSync(directory, { recursive: false, mode: 0o700 });
  const privateDir = join(directory, 'private');
  const evidenceDir = join(directory, 'evidence');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(evidenceDir, { mode: 0o700 });
  // Persist the public binding before spawning browsers, so a later supervisor
  // can recover journaled users even when this process is interrupted.
  writeFileSync(
    join(evidenceDir, 'run.json'),
    JSON.stringify({
      runId,
      status: 'running',
      before,
      evidenceDirectory: evidenceDir,
    }),
    { mode: 0o600 },
  );
  let exitCode = 1;
  let after = null;
  let failure = 'execution-failed';
  try {
    exitCode = await execute(
      previewWorkerEnvironment(env, before, privateDir, evidenceDir, runId, cloudUserIds),
    );
  } catch {
    // A raw process error can contain env, command output, or request details.
  }
  let cleanup = { status: 'failed', checked: 0, recovered: 0 };
  try {
    cleanup = await recover({
      evidenceDirectory: evidenceDir,
      runId,
      supabaseProjectRef: before.supabaseProjectRef,
      serviceKey: env.SUPABASE_SECRET_KEY,
    });
  } catch {
    // Invalid journal or raw provider errors cannot be disclosed.
  }
  try {
    after = await observe({ ...request, ...credentials });
  } catch {
    failure = 'post-readiness-failed';
  }
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(evidenceDir, 'e2e.json'), 'utf8'));
  } catch {
    failure = 'e2e-evidence-missing';
  }
  if (cleanup.status !== 'clean' || cleanup.checked < 2) failure = 'cleanup-unconfirmed';
  const passed =
    exitCode === 0 &&
    after !== null &&
    isPassingPreviewReport(report) &&
    cleanup.status === 'clean' &&
    cleanup.checked >= 2;
  const result = {
    runId,
    status: passed ? 'passed' : 'failed',
    failure: passed ? null : failure,
    before,
    after,
    cleanup,
    evidenceDirectory: evidenceDir,
  };
  // Raw Playwright output, including error-context files, is never an upload target.
  rmSync(privateDir, { recursive: true, force: true });
  writeFileSync(join(evidenceDir, 'run.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const request = parsePreviewReadinessArgs(process.argv.slice(2));
    const git = (args) =>
      execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(
          ['PATH', 'HOME', 'LANG'].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]]] : [],
          ),
        ),
      }).trim();
    if (git(['rev-parse', 'HEAD']) !== request.sha || git(['status', '--porcelain']) !== '') {
      throw new Error('Candidate checkout is not clean or does not match SHA');
    }
    const result = await runPreviewE2E({
      request: { ...request, expectedMigrations: expectedMigrationVersions(ROOT) },
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch {
    console.error('Preview E2E could not start; verify candidate identity and scoped credentials');
    process.exitCode = 1;
  }
}
