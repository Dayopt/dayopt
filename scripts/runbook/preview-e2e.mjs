#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedMigrationVersions } from '../ci/production-migration-readiness.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { isPassingPreviewReport } from '../lib/preview-e2e-reporter.mjs';
import {
  createPreviewRunManifest,
  ensurePreviewE2EStateRoot,
  listPreviewRecoveryRuns,
  previewE2EStateRoot,
  recoverPreviewE2ERun,
  requireTrustedRecoverySource,
  writePreviewRunManifest,
} from './preview-e2e-recovery.mjs';
import { observePreviewReadiness, parsePreviewReadinessArgs } from './preview-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function previewWorkerEnvironment(env, ready, privateDir, evidenceDir, runId) {
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
  };
}

/** @returns {Promise<number>} */
function executePlaywright(env) {
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
        cwd: ROOT,
        env,
        stdio: 'ignore',
        detached: true,
      },
    );
    let timedOut = false;
    let settled = false;
    let deadline;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      resolveExit(code);
    };
    const killGroup = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* group already exited */
      }
    };
    const interrupt = (signal) => {
      if (timedOut) return;
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => {
        killGroup('SIGKILL');
        finish(signal === 'SIGINT' ? 130 : 143);
      }, 3000);
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    deadline = setTimeout(
      () => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => {
          killGroup('SIGKILL');
          finish(1);
        }, 3000);
      },
      7 * 60 * 1000,
    );
    child.on('error', () => {
      finish(1);
    });
    child.on('exit', (code) => {
      if (!timedOut) {
        finish(code ?? 1);
      }
    });
  });
}

/**
 * The injected executor/readiness are test seams; the CLI always uses live implementations.
 * @param {{
 *   request: any,
 *   env?: NodeJS.ProcessEnv,
 *   observe?: typeof observePreviewReadiness,
 *   execute?: (env: any) => Promise<number>,
 *   tempRoot?: string,
 *   onStarted?: (started: { runId: string; evidenceDirectory: string }) => void,
 * }} options
 */
export async function runPreviewE2E({
  request,
  env = process.env,
  observe = observePreviewReadiness,
  execute = executePlaywright,
  tempRoot = previewE2EStateRoot(env),
  onStarted = () => {},
}) {
  if (!env.SUPABASE_SECRET_KEY?.trim())
    throw new Error('Nonproduction test credentials are required');
  const credentials = {
    vercelToken: env.VERCEL_TOKEN,
    supabaseToken: env.SUPABASE_PREVIEW_READINESS_TOKEN,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
  };
  const runId = randomUUID();
  const before = await observe({ ...request, ...credentials });
  const stateRoot = ensurePreviewE2EStateRoot(tempRoot);
  const directory = join(stateRoot, runId);
  mkdirSync(directory, { mode: 0o700 });
  const privateDir = join(directory, 'private');
  const evidenceDir = join(directory, 'evidence');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(evidenceDir, { mode: 0o700 });
  let manifest = createPreviewRunManifest({ runId, ready: before, evidenceDirectory: evidenceDir });
  writePreviewRunManifest(directory, manifest);
  try {
    onStarted?.({ runId, evidenceDirectory: evidenceDir });
  } catch {
    // Progress reporting must not alter run ownership or cleanup behavior.
  }
  const heartbeat = setInterval(() => {
    manifest = { ...manifest, heartbeatAt: new Date().toISOString() };
    writePreviewRunManifest(directory, manifest);
  }, 30_000);
  heartbeat.unref?.();
  let exitCode = 1;
  let after = null;
  let failure = 'execution-failed';
  try {
    exitCode = await execute(previewWorkerEnvironment(env, before, privateDir, evidenceDir, runId));
  } catch {
    // A raw process error can contain env, command output, or request details.
  } finally {
    clearInterval(heartbeat);
    rmSync(privateDir, { recursive: true, force: true });
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
  const passed = exitCode === 0 && after !== null && isPassingPreviewReport(report);
  const result = {
    runId,
    status: passed ? 'passed' : 'failed',
    failure: passed ? null : failure,
    before,
    after,
    evidenceDirectory: evidenceDir,
  };
  // Raw Playwright output, including error-context files, is never an upload target.
  writeFileSync(join(evidenceDir, 'run.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  manifest = {
    ...manifest,
    status: passed ? 'passed' : 'failed',
    heartbeatAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  writePreviewRunManifest(directory, manifest);
  return result;
}

function createPreviewAdmin(projectRef, secretKey) {
  const requireFromProduct = createRequire(join(ROOT, 'apps/product/package.json'));
  const { createClient } = requireFromProduct('@supabase/supabase-js');
  return createClient(`https://${projectRef}.supabase.co`, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertTrustedRecoveryCommandSource() {
  const gitEnvironment = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (gitArgs) =>
    execFileSync('git', gitArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', 'main'], {
    cwd: ROOT,
    env: gitEnvironment,
    stdio: 'ignore',
  });
  requireTrustedRecoverySource({
    headSha: git(['rev-parse', 'HEAD']),
    originMainSha: git(['rev-parse', 'refs/remotes/origin/main']),
    clean: git(['status', '--porcelain', '--untracked-files=normal']) === '',
  });
}

if (isDirectExecution(import.meta.url)) {
  try {
    const stateRoot = previewE2EStateRoot(process.env);
    const args = process.argv.slice(2);
    if (args[0] === '--list-recovery-runs' && args.length === 1) {
      console.log(JSON.stringify(listPreviewRecoveryRuns(stateRoot), null, 2));
    } else if (args[0] === '--recover-run' && args.length === 2) {
      assertTrustedRecoveryCommandSource();
      const result = await recoverPreviewE2ERun({
        runId: args[1],
        stateRoot,
        observe: observePreviewReadiness,
        createAdmin: createPreviewAdmin,
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const request = parsePreviewReadinessArgs(args);
      const git = (gitArgs) =>
        execFileSync('git', gitArgs, {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (git(['rev-parse', 'HEAD']) !== request.sha || git(['status', '--porcelain']) !== '') {
        throw new Error('Candidate checkout is not clean or does not match SHA');
      }
      const result = await runPreviewE2E({
        request: { ...request, expectedMigrations: expectedMigrationVersions(ROOT) },
        onStarted: ({ runId, evidenceDirectory }) =>
          console.log(JSON.stringify({ runId, status: 'running', evidenceDirectory })),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'passed') process.exitCode = 1;
    }
  } catch {
    console.error(
      'Preview E2E command failed; verify trusted source, candidate identity, and scoped credentials',
    );
    process.exitCode = 1;
  }
}
