import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedMigrationVersions } from '../ci/production-migration-readiness.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { validateCloudRequest } from '../lib/preview-cloud-binding.mjs';
import { isPassingPreviewReport } from '../lib/preview-e2e-reporter.mjs';
import { recoverPreviewUsers } from '../runbook/preview-cleanup.mjs';
import { runPreviewE2E } from '../runbook/preview-e2e.mjs';
import { validateCloudIntent } from './preview-cloud-intent.mjs';

export { validateCloudRequest } from '../lib/preview-cloud-binding.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function verifyCloudFixtureContract(candidateRoot, trustedRoot = ROOT) {
  // Older candidates would silently allocate random IDs absent from the durable
  // intent. Require the trusted allocation contract before any fixture mutation.
  for (const path of [
    'apps/product/src/lib/test/preview-cloud-identity.ts',
    'apps/product/src/lib/test/e2e/critical-path-fixture.ts',
  ]) {
    const source = readFileSync(join(trustedRoot, path));
    const target = join(candidateRoot, path);
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 512 * 1024 ||
      !source.equals(readFileSync(target))
    )
      throw new Error('Cloud Preview candidate fixture contract differs');
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES = new Set([
  'creating',
  'creation-unconfirmed',
  'created',
  'cleanup-failed',
  'deleted',
]);
const FILES = new Set([
  'critical-path.spec.ts',
  'mobile-critical-path.spec.ts',
  'preview-authorization.spec.ts',
]);
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
  intent = undefined,
}) {
  const bound = validateCloudRequest(request);
  const run = readRun(directory, bound);
  if (intent) {
    const plan = validateCloudIntent(intent);
    if (
      run.runId !== plan.runId ||
      Object.entries(bound).some(([key, value]) => plan.request[key] !== value)
    )
      throw new Error();
    for (const name of readdirSync(join(directory, 'evidence', 'users')).filter((name) =>
      name.endsWith('.json'),
    )) {
      const row = readJson(join(directory, 'evidence', 'users', name));
      if (!Object.values(plan.userIds).includes(row.userId)) throw new Error();
    }
  }
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

const STEP_CATEGORIES = new Set(['expect', 'pw:api', 'test.step', 'fixture', 'hook', 'other']);

/** Candidate reporter metadata is untrusted: rebuild only bounded diagnostic coordinates. */
function publicSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 2000).map((step) => ({
    category: STEP_CATEGORIES.has(step?.category) ? step.category : 'other',
    file: FILES.has(step?.file) ? step.file : null,
    line:
      Number.isSafeInteger(step?.line) && step.line > 0 && step.line <= 1_000_000
        ? step.line
        : null,
    duration:
      Number.isFinite(step?.duration) && step.duration >= 0 && step.duration <= 20 * 60 * 1000
        ? step.duration
        : 0,
    failed: step?.failed === true,
  }));
}

/** Reconstruct a JSON-only public artifact. Never copy browser output, screenshots, or raw JSON. */
export function publishCloudEvidence({ directory, destination, request, intent = undefined }) {
  const bound = validateCloudRequest(request);
  const plan = intent ? validateCloudIntent(intent) : null;
  if (plan && Object.entries(bound).some(([key, value]) => plan.request[key] !== value))
    throw new Error('Cloud Preview intent binding differs');
  let run;
  try {
    run = readRun(directory, bound);
    if (plan && run.runId !== plan.runId) throw new Error();
  } catch {
    const output = {
      request: bound,
      status: 'failed',
      runBindingConfirmed: false,
      cleanupConfirmed: false,
      tests: [],
      users: [],
      ...(plan ? { intent: plan } : {}),
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
    ...(plan ? { intent: plan } : {}),
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
        steps: publicSteps(test.steps),
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
        !STATES.has(row.status) ||
        (plan && !Object.values(plan.userIds).includes(row.userId))
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
    const [operation, requestFile, candidatePath, runPath, artifactPath, intentPath, ...rest] =
      process.argv.slice(2);
    if (
      rest.length ||
      !['execute', 'cleanup', 'publish'].includes(operation) ||
      !artifactPath ||
      !intentPath
    )
      throw new Error();
    const request = validateCloudRequest(readJson(requestFile));
    const intent = validateCloudIntent(readJson(intentPath));
    if (
      Object.entries(request).some(([key, value]) => intent.request[key] !== value) ||
      intent.sourceRunId !== Number(process.env.GITHUB_RUN_ID) ||
      intent.sourceAttempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
      intent.workflowSha !== process.env.GITHUB_SHA
    )
      throw new Error();
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
      verifyCloudFixtureContract(candidateRoot);
      await assertCloudFixtureKey({ request, serviceKey: process.env.SUPABASE_SECRET_KEY });
      const result = await runPreviewE2E({
        candidateRoot,
        runDirectory: directory,
        request: { ...request, expectedMigrations: expectedMigrationVersions(candidateRoot) },
        runId: intent.runId,
        cloudUserIds: intent.userIds,
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
        intent,
      });
      console.log(JSON.stringify(result));
      if (result.status !== 'clean') process.exitCode = 1;
    } else {
      publishCloudEvidence({ directory, destination: resolve(artifactPath), request, intent });
      console.log('Public Cloud Preview evidence prepared');
    }
  } catch {
    console.error(
      'Cloud Preview operation failed; check trusted binding, readiness, and scoped credentials',
    );
    process.exitCode = 1;
  }
}
