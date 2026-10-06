import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedMigrationVersions } from '../ci/production-migration-readiness.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { resolvePreviewSecretKey } from '../lib/preview-branch-key.mjs';
import { validateCloudRequest } from '../lib/preview-cloud-binding.mjs';
import {
  isPassingPreviewReport,
  isPreviewE2EFile,
  safePreviewFailedSteps,
  safePreviewProcedureBudget,
} from '../lib/preview-e2e-reporter.mjs';
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
    'apps/product/src/lib/test/e2e/account-deletion-fixture.ts',
    'apps/product/src/lib/test/e2e/create-scoped-test-user.ts',
    'apps/product/src/lib/test/e2e/preview-access-fixture.ts',
    'apps/product/src/lib/test/e2e/trpc-response-mock.ts',
    'apps/product/src/lib/test/e2e/trpc-budget-fixture.ts',
    'apps/product/src/lib/test/preview-user-lifecycle.ts',
    'apps/product/src/lib/test/preview-access.ts',
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
const PROJECTS = new Set(['chromium', 'Mobile Chrome']);
const TEST_STATES = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown']);
const PREFLIGHT_STAGES = new Set([
  'candidate-binding',
  'fixture-contract',
  'fixture-key',
  'migration-inventory',
  'runner-preflight',
]);

function readPreflightFailureStage(directory) {
  // A malformed or mismatched journal keeps the existing generic binding failure.
  if (existsSync(join(directory, 'evidence', 'run.json'))) return null;
  try {
    const marker = readJson(join(directory, 'preflight-failure.json'));
    return PREFLIGHT_STAGES.has(marker?.stage) ? marker.stage : null;
  } catch {
    return null;
  }
}

function recordPreflightFailure(directory, stage) {
  if (!PREFLIGHT_STAGES.has(stage) || existsSync(join(directory, 'evidence', 'run.json'))) return;
  // Only the trusted execute path writes this fixed enum after invocation binding succeeds.
  // This diagnostic is not an ownership journal and cannot authorize recovery or success.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'preflight-failure.json'), JSON.stringify({ stage }), {
    mode: 0o600,
    flag: 'wx',
  });
}
const safeGitEnv = () =>
  Object.fromEntries(
    ['PATH', 'HOME', 'LANG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );

function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Authenticate the selected key against the selected nonproduction Auth API before creating fixtures.
 * @param {{request: ReturnType<typeof validateCloudRequest>, serviceKey: string | undefined, userIds?: Record<string, string>, fetchImpl?: typeof fetch}} options
 */
export async function assertCloudFixtureKey({
  request,
  serviceKey,
  userIds = undefined,
  fetchImpl = fetch,
}) {
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
    if (userIds !== undefined) {
      const ids = Object.values(userIds);
      if (
        !ids.length ||
        !ids.every((id) => UUID.test(id) && id !== '00000000-0000-0000-0000-000000000001') ||
        new Set(ids).size !== ids.length
      )
        throw new Error();
      for (const id of ids) {
        const planned = await fetchImpl(
          `https://${bound.supabaseProjectRef}.supabase.co/auth/v1/admin/users/${id}`,
          {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          },
        );
        if (planned.status !== 404) throw new Error();
      }
    }
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

/** Always-step recovery on a surviving Actions VM. A destroyed VM needs journal replay elsewhere.
 * @param {{directory: string, request: ReturnType<typeof validateCloudRequest>, serviceKey?: string, resolveServiceKey?: (input: {bound: ReturnType<typeof validateCloudRequest>, run: any, intent: any}) => Promise<string>, recover?: typeof recoverPreviewUsers, intent?: any}} options
 */
export async function cleanupCloudRun({
  directory,
  request,
  serviceKey,
  resolveServiceKey = undefined,
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
  const resolvedKey = resolveServiceKey
    ? await resolveServiceKey({ bound, run, intent })
    : serviceKey;
  if (typeof resolvedKey !== 'string' || !resolvedKey.trim()) throw new Error();
  const cleanup = await recover({
    evidenceDirectory: join(directory, 'evidence'),
    runId: run.runId,
    supabaseProjectRef: bound.supabaseProjectRef,
    serviceKey: resolvedKey,
  });
  writeFileSync(
    join(directory, 'evidence', 'cloud-cleanup.json'),
    JSON.stringify({ runId: run.runId, ...cleanup }),
    { mode: 0o600 },
  );
  return cleanup;
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
    const preflightFailureStage = readPreflightFailureStage(directory);
    const output = {
      request: bound,
      status: 'failed',
      runBindingConfirmed: false,
      ...(preflightFailureStage ? { preflightFailureStage } : {}),
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
        !isPreviewE2EFile(test.file) ||
        !PROJECTS.has(test.project) ||
        !TEST_STATES.has(test.status) ||
        !Number.isSafeInteger(test.line) ||
        !Number.isSafeInteger(test.retry)
      )
        throw new Error();
      const procedureBudget = safePreviewProcedureBudget(test.procedureBudget);
      return {
        file: test.file,
        project: test.project,
        line: test.line,
        status: test.status,
        retry: test.retry,
        expectedPassed: test.expectedPassed === true,
        failedSteps: safePreviewFailedSteps(test),
        ...(procedureBudget ? { procedureBudget } : {}),
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
      cleanup.checked >= (plan?.schemaVersion === 2 ? 3 : 2) &&
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
  let failureDirectory;
  let failureStage;
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
      (operation === 'execute' && intent.schemaVersion !== 2) ||
      Object.entries(request).some(([key, value]) => intent.request[key] !== value) ||
      intent.sourceRunId !== Number(process.env.GITHUB_RUN_ID) ||
      intent.sourceAttempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
      intent.workflowSha !== process.env.GITHUB_SHA
    )
      throw new Error();
    const candidateRoot = resolve(candidatePath);
    const directory = resolve(runPath);
    if (operation === 'execute') {
      failureDirectory = directory;
      failureStage = 'candidate-binding';
      const git = (args) =>
        execFileSync('git', args, {
          cwd: candidateRoot,
          encoding: 'utf8',
          env: safeGitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (git(['rev-parse', 'HEAD']) !== request.sha || git(['status', '--porcelain']) !== '')
        throw new Error();
      failureStage = 'fixture-contract';
      verifyCloudFixtureContract(candidateRoot);
      failureStage = 'migration-inventory';
      const expectedMigrations = expectedMigrationVersions(candidateRoot);
      failureStage = 'runner-preflight';
      const result = await runPreviewE2E({
        resolveServiceKey: async ({ ready }) => {
          failureStage = 'fixture-key';
          const serviceKey = await resolvePreviewSecretKey({
            projectRef: ready.supabaseProjectRef,
            provisionToken: process.env.SUPABASE_PREVIEW_PROVISION_TOKEN,
          });
          await assertCloudFixtureKey({ request, serviceKey, userIds: intent.userIds });
          return serviceKey;
        },
        runDirectory: directory,
        request: { ...request, expectedMigrations },
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
        intent,
        resolveServiceKey: async ({ bound }) => {
          const serviceKey = await resolvePreviewSecretKey({
            projectRef: bound.supabaseProjectRef,
            provisionToken: process.env.SUPABASE_PREVIEW_PROVISION_TOKEN,
          });
          await assertCloudFixtureKey({ request: bound, serviceKey });
          return serviceKey;
        },
      });
      console.log(JSON.stringify(result));
      if (result.status !== 'clean') process.exitCode = 1;
    } else {
      publishCloudEvidence({ directory, destination: resolve(artifactPath), request, intent });
      console.log('Public Cloud Preview evidence prepared');
    }
  } catch {
    if (
      failureDirectory &&
      PREFLIGHT_STAGES.has(failureStage) &&
      !existsSync(join(failureDirectory, 'evidence', 'run.json'))
    ) {
      try {
        recordPreflightFailure(failureDirectory, failureStage);
      } catch {
        // Storage failure preserves the generic fallback; never log a path or filesystem error.
      }
      console.error(JSON.stringify({ preflightFailureStage: failureStage }));
    }
    console.error(
      'Cloud Preview operation failed; check trusted binding, readiness, and scoped credentials',
    );
    process.exitCode = 1;
  }
}
