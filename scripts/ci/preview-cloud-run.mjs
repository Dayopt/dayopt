import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expectedMigrationVersions } from '../ci/production-migration-readiness.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { isPassingPreviewReport } from '../lib/preview-e2e-reporter.mjs';
import { recoverPreviewUsers } from '../runbook/preview-cleanup.mjs';
import { runPreviewE2E } from '../runbook/preview-e2e.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REF = /^[a-z]{20}$/;
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set([
  'creating',
  'creation-unconfirmed',
  'created',
  'cleanup-failed',
  'deleted',
]);
const FILES = new Set(['critical-path.spec.ts', 'mobile-critical-path.spec.ts']);
const PROJECTS = new Set(['chromium', 'Mobile Chrome']);
const TEST_STATES = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown']);
const safeGitEnv = () =>
  Object.fromEntries(
    ['PATH', 'HOME', 'LANG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );

function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateCloudRequest(request) {
  if (
    !request ||
    !SHA.test(request.sha ?? '') ||
    !/^dpl_[a-zA-Z0-9]+$/.test(request.deploymentId ?? '') ||
    !Number.isSafeInteger(request.prNumber) ||
    request.prNumber < 1 ||
    typeof request.branchName !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,199}$/.test(request.branchName) ||
    ['main', 'integration'].includes(request.branchName) ||
    !REF.test(request.supabaseProjectRef ?? '') ||
    request.supabaseProjectRef === 'yvglwblxrnrenfifsnje' ||
    !UUID.test(request.supabaseBranchId ?? '') ||
    !['shared', 'ephemeral'].includes(request.databaseMode)
  )
    throw new Error('Invalid Cloud Preview binding');
  const sharedRef = 'tilwaprottpyhlfoggbb';
  const sharedBranch = '4c2ed092-cba3-4f37-98e1-78f61cdf52ed';
  if (
    request.databaseMode === 'shared'
      ? request.supabaseProjectRef !== sharedRef || request.supabaseBranchId !== sharedBranch
      : request.supabaseProjectRef === sharedRef || request.supabaseBranchId === sharedBranch
  ) {
    throw new Error('Cloud Preview database mode does not match its binding');
  }
  return Object.fromEntries(
    [
      'sha',
      'deploymentId',
      'prNumber',
      'branchName',
      'supabaseProjectRef',
      'supabaseBranchId',
      'databaseMode',
    ].map((key) => [key, request[key]]),
  );
}

/** Authenticate the selected key against the selected nonproduction Auth API before creating fixtures. */
export async function assertCloudFixtureKey({ request, serviceKey, fetchImpl = fetch }) {
  const bound = validateCloudRequest(request);
  if (!serviceKey?.trim()) throw new Error('Cloud Preview fixture key is missing');
  if (!serviceKey.startsWith('sb_secret_')) {
    try {
      const parts = serviceKey.split('.');
      if (parts.length !== 3) throw new Error();
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (claims.role !== 'service_role' || claims.ref !== bound.supabaseProjectRef)
        throw new Error();
    } catch {
      throw new Error('Cloud Preview fixture key binding differs');
    }
  }
  try {
    const response = await fetchImpl(
      `https://${bound.supabaseProjectRef}.supabase.co/auth/v1/admin/users/00000000-0000-0000-0000-000000000001`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      },
    );
    if (!response.ok || (await response.json())?.id !== '00000000-0000-0000-0000-000000000001')
      throw new Error();
  } catch {
    throw new Error('Cloud Preview fixture key or baseline is not ready');
  }
}

function readRun(directory, request) {
  const run = readJson(join(directory, 'evidence', 'run.json'));
  if (!UUID.test(run.runId ?? '') || !['running', 'failed', 'passed'].includes(run.status))
    throw new Error();
  for (const [key, value] of Object.entries(request))
    if (run.before?.[key] !== value) throw new Error();
  if (!/^https:\/\/product-[a-z0-9]+-dayopt\.vercel\.app$/.test(run.before?.origin ?? ''))
    throw new Error();
  if (
    !Array.isArray(run.before.migrationVersions) ||
    !run.before.migrationVersions.length ||
    !run.before.migrationVersions.every((version) => /^\d{14}$/.test(version))
  )
    throw new Error();
  return run;
}

/** Always-step recovery on a surviving Actions VM. A destroyed VM needs journal replay elsewhere. */
export async function cleanupCloudRun({
  directory,
  request,
  serviceKey,
  recover = recoverPreviewUsers,
}) {
  const bound = validateCloudRequest(request);
  const run = readRun(directory, bound);
  const cleanup = await recover({
    evidenceDirectory: join(directory, 'evidence'),
    runId: run.runId,
    supabaseProjectRef: bound.supabaseProjectRef,
    serviceKey,
  });
  writeFileSync(
    join(directory, 'evidence', 'cloud-cleanup.json'),
    JSON.stringify({ runId: run.runId, ...cleanup }),
    { mode: 0o600 },
  );
  return cleanup;
}

/** Reconstruct a JSON-only public artifact. Never copy browser output, screenshots, or raw JSON. */
export function publishCloudEvidence({ directory, destination, request }) {
  const bound = validateCloudRequest(request);
  let run;
  try {
    run = readRun(directory, bound);
  } catch {
    const output = {
      request: bound,
      status: 'failed',
      runBindingConfirmed: false,
      cleanupConfirmed: false,
      tests: [],
      users: [],
    };
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    writeFileSync(join(destination, 'preview.json'), JSON.stringify(output, null, 2), {
      mode: 0o600,
    });
    return output;
  }
  const output = {
    request: bound,
    runId: run.runId,
    status: run.status === 'passed' ? 'passed' : 'failed',
    origin: run.before.origin,
    migrationVersions: run.before.migrationVersions,
    postReadinessConfirmed:
      run.after?.status === 'ready' &&
      Object.entries(bound).every(([key, value]) => run.after[key] === value) &&
      run.after.origin === run.before.origin &&
      JSON.stringify(run.after.migrationVersions) === JSON.stringify(run.before.migrationVersions),
    tests: [],
    users: [],
    reportComplete: false,
    testsPassed: false,
    journalComplete: false,
    cleanupConfirmed: false,
  };
  try {
    const report = readJson(join(directory, 'evidence', 'e2e.json'));
    if (!Array.isArray(report.tests) || report.tests.length > 200) throw new Error();
    output.reportComplete = true;
    output.testsPassed = isPassingPreviewReport(report);
    output.tests = report.tests.map((test) => {
      if (
        !FILES.has(test.file) ||
        !PROJECTS.has(test.project) ||
        !TEST_STATES.has(test.status) ||
        !Number.isSafeInteger(test.line) ||
        !Number.isSafeInteger(test.retry)
      )
        throw new Error();
      return {
        file: test.file,
        project: test.project,
        line: test.line,
        status: test.status,
        retry: test.retry,
        expectedPassed: test.expectedPassed === true,
      };
    });
  } catch {
    output.tests = [];
    output.reportComplete = false;
  }
  const users = join(directory, 'evidence', 'users');
  try {
    const stat = lstatSync(users);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const names = readdirSync(users).filter((name) => name.endsWith('.json'));
    if (names.length > 256) throw new Error();
    output.journalComplete = true;
    output.users = names.map((name) => {
      const row = readJson(join(users, name));
      if (
        !UUID.test(row.userId ?? '') ||
        row.userId === '00000000-0000-0000-0000-000000000001' ||
        name !== `${row.userId}.json` ||
        row.runId !== run.runId ||
        !STATES.has(row.status)
      )
        throw new Error();
      return { userId: row.userId, runId: row.runId, status: row.status };
    });
  } catch {
    output.users = [];
    output.journalComplete = false;
  }
  try {
    const cleanup = readJson(join(directory, 'evidence', 'cloud-cleanup.json'));
    output.cleanupConfirmed =
      cleanup.runId === run.runId &&
      cleanup.status === 'clean' &&
      Number.isSafeInteger(cleanup.checked) &&
      cleanup.checked >= 2 &&
      output.journalComplete &&
      cleanup.checked === output.users.length &&
      output.users.every((user) => user.status === 'deleted');
  } catch {
    /* Missing recovery confirmation is never success. */
  }
  if (
    output.status === 'passed' &&
    (!output.postReadinessConfirmed ||
      !output.reportComplete ||
      !output.testsPassed ||
      !output.cleanupConfirmed)
  )
    output.status = 'failed';
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  writeFileSync(join(destination, 'preview.json'), JSON.stringify(output, null, 2), {
    mode: 0o600,
  });
  return output;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [operation, requestFile, candidatePath, runPath, artifactPath, ...rest] =
      process.argv.slice(2);
    if (rest.length || !['execute', 'cleanup', 'publish'].includes(operation) || !artifactPath)
      throw new Error();
    const request = validateCloudRequest(readJson(requestFile));
    const candidateRoot = resolve(candidatePath);
    const directory = resolve(runPath);
    if (operation === 'execute') {
      const git = (args) =>
        execFileSync('git', args, {
          cwd: candidateRoot,
          encoding: 'utf8',
          env: safeGitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (git(['rev-parse', 'HEAD']) !== request.sha || git(['status', '--porcelain']) !== '')
        throw new Error();
      await assertCloudFixtureKey({ request, serviceKey: process.env.SUPABASE_SECRET_KEY });
      const result = await runPreviewE2E({
        candidateRoot,
        runDirectory: directory,
        request: { ...request, expectedMigrations: expectedMigrationVersions(candidateRoot) },
      });
      console.log(
        JSON.stringify({ runId: result.runId, status: result.status, cleanup: result.cleanup }),
      );
      if (result.status !== 'passed') process.exitCode = 1;
    } else if (operation === 'cleanup') {
      const result = await cleanupCloudRun({
        directory,
        request,
        serviceKey: process.env.SUPABASE_SECRET_KEY,
      });
      console.log(JSON.stringify(result));
      if (result.status !== 'clean') process.exitCode = 1;
    } else {
      publishCloudEvidence({ directory, destination: resolve(artifactPath), request });
      console.log('Public Cloud Preview evidence prepared');
    }
  } catch {
    console.error(
      'Cloud Preview operation failed; check trusted binding, readiness, and scoped credentials',
    );
    process.exitCode = 1;
  }
}
