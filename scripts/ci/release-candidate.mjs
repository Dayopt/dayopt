import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

export const CANDIDATE_SUITES = ['unit', 'integration', 'db_upgrade', 'e2e', 'web', 'storybook'];
const CANDIDATE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml';
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const positiveId = /^[1-9][0-9]*$/;
const migrationDirectory = 'supabase/migrations/';
export const POC_MIGRATION_PATH =
  'supabase/migrations/20261003073817_supabase_rate_limit_idempotency_poc.sql';
export const POC_MIGRATION_ACTIVE_SHA256 =
  '11dd31c45ac6eb95b329d00c8ade766b4d625626a7c5fb1b37614e4322999905';
export const POC_MIGRATION_TOMBSTONE =
  '-- POC migration retired; original SQL is preserved in supabase/migrations/_archive/20261003073817_supabase_rate_limit_idempotency_poc.sql.\nSELECT 1;\n';
const pocMigrationTombstoneSha256 = createHash('sha256')
  .update(POC_MIGRATION_TOMBSTONE)
  .digest('hex');
const suiteSteps = {
  unit: 'Full unit and workspace tests',
  integration: 'Full integration and RLS tests',
  db_upgrade: 'Rehearse the pinned main to candidate migration upgrade',
  e2e: 'Full Product E2E',
  web: 'Web build and E2E',
  storybook: 'Storybook light and dark',
};

function requireValue(condition, detail) {
  if (!condition) throw new Error(`Candidate held: ${detail}`);
}

export function isTrustedCandidateWorkflowPath(path) {
  return path === CANDIDATE_WORKFLOW_PATH || path === `${CANDIDATE_WORKFLOW_PATH}@main`;
}

function timestamp(value) {
  requireValue(typeof value === 'string' && /Z$/.test(value), 'UTC timestamp is required');
  const result = Date.parse(value);
  requireValue(Number.isFinite(result), 'invalid timestamp');
  return result;
}

export function createCandidate(input) {
  requireValue(input && typeof input === 'object', 'missing snapshot');
  const { sha, tree, mainSha, mainTree, runId, attempt, capturedAt, db } = input;
  for (const value of [sha, tree, mainSha, mainTree])
    requireValue(typeof value === 'string' && shaPattern.test(value), 'full SHA/tree is required');
  for (const value of [runId, attempt])
    requireValue(typeof value === 'string' && positiveId.test(value), 'invalid run/attempt');
  const captured = timestamp(capturedAt);
  requireValue(db && typeof db === 'object', 'DB evidence is missing');
  requireValue(
    typeof db.identity === 'string' && db.identity.endsWith(`:${runId}:${attempt}`),
    'DB identity must belong to this run attempt',
  );
  requireValue(
    hashPattern.test(db.migrationHash) && hashPattern.test(db.schemaHash),
    'DB hashes are missing',
  );
  requireValue(timestamp(db.observedAt) >= captured, 'DB evidence predates candidate capture');
  return { version: 1, sha, tree, mainSha, mainTree, runId, attempt, capturedAt, db: { ...db } };
}

export function assertCandidate({
  candidate,
  results,
  currentMainSha,
  actualTree,
  currentDb,
  now,
  maxAgeSeconds,
  run,
}) {
  requireValue(candidate?.version === 1, 'unsupported evidence version');
  createCandidate(candidate);
  requireValue(results && typeof results === 'object', 'suite evidence is missing');
  requireValue(
    Object.keys(results).length === CANDIDATE_SUITES.length,
    'suite evidence is incomplete',
  );
  for (const suite of CANDIDATE_SUITES)
    requireValue(results[suite] === 'success', `${suite} is not green`);
  requireValue(currentMainSha === candidate.mainSha, 'main advanced; capture and verify again');
  requireValue(actualTree === candidate.tree, 'tested and promotion trees differ');
  for (const key of ['identity', 'migrationHash', 'schemaHash'])
    requireValue(currentDb?.[key] === candidate.db[key], `DB ${key} changed`);
  requireValue(
    Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds > 0,
    'approved freshness limit is missing',
  );
  const nowMs = typeof now === 'number' ? now : timestamp(now);
  requireValue(timestamp(candidate.db.observedAt) <= nowMs, 'DB evidence is from the future');
  const age = nowMs - timestamp(candidate.capturedAt);
  requireValue(
    Number.isFinite(age) && age >= 0 && age <= maxAgeSeconds * 1000,
    'candidate is stale or from the future',
  );
  requireValue(
    run &&
      String(run.id) === candidate.runId &&
      String(run.run_attempt) === candidate.attempt &&
      run.head_sha === candidate.mainSha &&
      run.head_branch === 'main' &&
      isTrustedCandidateWorkflowPath(run.path) &&
      run.status === 'completed' &&
      run.conclusion === 'success',
    'trusted completed candidate run is missing or was rerun',
  );
  return candidate;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (...args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));

export function assertCandidateStart({ eventName, schedule, now, maxDelaySeconds }) {
  if (eventName === 'workflow_dispatch') return;
  const daily = typeof schedule === 'string' && schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  requireValue(
    eventName === 'schedule' && daily && Number(daily[1]) < 60 && Number(daily[2]) < 24,
    'approved daily UTC schedule is required',
  );
  requireValue(
    Number.isSafeInteger(maxDelaySeconds) && maxDelaySeconds > 0 && maxDelaySeconds < 86400,
    'approved schedule delay limit is missing',
  );
  const time = timestamp(now);
  const slot = new Date(time);
  slot.setUTCHours(Number(daily[2]), Number(daily[1]), 0, 0);
  if (slot.getTime() > time) slot.setUTCDate(slot.getUTCDate() - 1);
  requireValue(
    time - slot.getTime() <= maxDelaySeconds * 1000,
    'scheduled candidate started too late',
  );
}

export function assertCandidatePocMigrationRetired({
  candidateSha,
  gitImpl = git,
  readBlob = (object) => execFileSync('git', ['cat-file', 'blob', object], { encoding: 'buffer' }),
  hashContents = (contents) => createHash('sha256').update(contents).digest('hex'),
}) {
  const listing = gitImpl('ls-tree', candidateSha, '--', POC_MIGRATION_PATH);
  if (!listing) return;
  const [metadata, path] = listing.split('\t');
  const [mode, type, object] = metadata.split(' ');
  requireValue(
    path === POC_MIGRATION_PATH && type === 'blob' && ['100644', '100755'].includes(mode),
    'candidate contains an invalid POC migration entry',
  );
  const contents = readBlob(object);
  const digest = hashContents(contents);
  requireValue(
    digest !== POC_MIGRATION_ACTIVE_SHA256 &&
      digest === pocMigrationTombstoneSha256 &&
      Buffer.from(contents).equals(Buffer.from(POC_MIGRATION_TOMBSTONE)),
    'candidate POC migration must be absent or the canonical retired tombstone',
  );
}

// Control code is checked out from main. Candidate code only runs on read-only,
// disposable test workers; neither its scripts nor its artifact select a release.
export function pinCandidate({
  repository = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT,
  controlSha = process.env.GITHUB_SHA,
  now = () => new Date().toISOString(),
  api = gh,
  gitImpl = git,
  readBlob = (object) => execFileSync('git', ['cat-file', 'blob', object], { encoding: 'buffer' }),
  hashContents = (contents) => createHash('sha256').update(contents).digest('hex'),
} = {}) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'invalid repository');
  requireValue(process.env.GITHUB_REF === 'refs/heads/main', 'candidate control must run on main');
  const capturedAt = now();
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  assertCandidateStart({
    eventName: process.env.GITHUB_EVENT_NAME,
    schedule: event.schedule,
    now: capturedAt,
    maxDelaySeconds: Number(process.env.RELEASE_CANDIDATE_MAX_DELAY_SECONDS),
  });
  const main = api(`repos/${repository}/git/ref/heads/main`).object.sha;
  const sha = api(`repos/${repository}/git/ref/heads/integration`).object.sha;
  requireValue(main === controlSha, 'main advanced before capture');
  requireValue(shaPattern.test(sha) && shaPattern.test(main), 'invalid branch SHA');
  gitImpl('fetch', 'origin', main, sha);
  // Retain every main hotfix. Divergence is resolved through an ordinary PR,
  // never by manufacturing a tree that drops main changes.
  gitImpl('merge-base', '--is-ancestor', main, sha);
  assertCandidatePocMigrationRetired({ candidateSha: sha, gitImpl, readBlob, hashContents });
  return {
    sha,
    tree: gitImpl('rev-parse', `${sha}^{tree}`),
    mainSha: main,
    mainTree: gitImpl('rev-parse', `${main}^{tree}`),
    runId,
    attempt,
    capturedAt,
  };
}

export function verifyCandidateEvidence({
  evidence,
  run,
  currentMainSha,
  actualTree,
  now = new Date().toISOString(),
  maxAgeSeconds,
}) {
  requireValue(evidence && typeof evidence === 'object', 'artifact is missing');
  requireValue(evidence.version === 2, 'unsupported sealed evidence version');
  requireValue(
    evidence.databaseEvidence?.source === 'verification-runner-report' &&
      evidence.databaseEvidence?.migrationContentMatched === true,
    'database reports were not sealed against candidate migration content',
  );
  return assertCandidate({
    candidate: evidence.candidate,
    results: evidence.results,
    currentDb: evidence.dbAfter,
    run,
    currentMainSha,
    actualTree,
    now,
    maxAgeSeconds,
  });
}

const gitAt = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const gitBlob = (root, object) =>
  execFileSync('git', ['-C', root, 'cat-file', 'blob', object], { encoding: 'buffer' });

export function hashCandidateMigrations({
  candidateRoot,
  gitImpl = gitAt,
  readBlob = (object) => gitBlob(candidateRoot, object),
}) {
  const entries = gitImpl(candidateRoot, 'ls-tree', '-rz', 'HEAD', '--', 'supabase/migrations')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [metadata, path] = entry.split('\t');
      const [mode, type, object] = metadata.split(' ');
      return { mode, type, object, path };
    })
    .filter(
      ({ path }) =>
        path?.startsWith(migrationDirectory) &&
        !path.slice(migrationDirectory.length).includes('/'),
    )
    .filter(({ path }) => /^\d{14}_.+\.sql$/.test(path.slice(migrationDirectory.length)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  requireValue(entries.length > 0, 'candidate migration set is missing');
  const hash = createHash('sha256');
  for (const entry of entries) {
    requireValue(
      entry.type === 'blob' && ['100644', '100755'].includes(entry.mode),
      `candidate migration is not a regular git blob: ${entry.path}`,
    );
    hash
      .update(entry.path.slice(migrationDirectory.length))
      .update('\0')
      .update(readBlob(entry.object))
      .update('\0');
  }
  return hash.digest('hex');
}

function validateRunnerDbSnapshot(snapshot, { runId, attempt, migrationHash, label }) {
  requireValue(snapshot && typeof snapshot === 'object', `${label} DB report is missing`);
  requireValue(
    typeof snapshot.identity === 'string' &&
      new RegExp(`^runner:[0-9a-f]+:${runId}:${attempt}$`).test(snapshot.identity),
    `${label} DB identity is malformed or belongs to another attempt`,
  );
  requireValue(snapshot.migrationHash === migrationHash, `${label} DB migration content differs`);
  requireValue(hashPattern.test(snapshot.schemaHash), `${label} DB schema hash is malformed`);
  timestamp(snapshot.observedAt);
  return snapshot;
}

export function suiteResultsFromJobs({ jobsResponse, runId, attempt, headSha }) {
  requireValue(
    Array.isArray(jobsResponse?.jobs) &&
      (jobsResponse.total_count === undefined ||
        jobsResponse.total_count === jobsResponse.jobs.length),
    'GitHub Jobs API response is incomplete',
  );
  const verifyJobs = jobsResponse.jobs.filter((job) => job.name === 'verify');
  requireValue(verifyJobs.length === 1, 'GitHub Jobs API verify job is missing or ambiguous');
  const verify = verifyJobs[0];
  requireValue(
    String(verify.run_id) === String(runId) &&
      String(verify.run_attempt) === String(attempt) &&
      verify.head_sha === headSha &&
      verify.status === 'completed' &&
      verify.conclusion === 'success',
    'GitHub Jobs API verify job identity or conclusion is invalid',
  );
  requireValue(Array.isArray(verify.steps), 'GitHub Jobs API suite steps are missing');
  const results = {};
  for (const suite of CANDIDATE_SUITES) {
    const matches = verify.steps.filter((step) => step.name === suiteSteps[suite]);
    requireValue(matches.length === 1, `GitHub Jobs API ${suite} step is missing or ambiguous`);
    requireValue(
      matches[0].status === 'completed' && matches[0].conclusion === 'success',
      `GitHub Jobs API ${suite} step is not explicitly successful`,
    );
    results[suite] = 'success';
  }
  return results;
}

export function sealCandidateEvidence({
  pin,
  dbBefore,
  dbAfter,
  run,
  jobsResponse,
  repository,
  runId,
  attempt,
  controlRoot,
  candidateRoot,
  maxAgeSeconds,
  now = new Date().toISOString(),
  gitImpl = gitAt,
  readBlob,
}) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'invalid repository');
  requireValue(
    run &&
      String(run.id) === String(runId) &&
      String(run.run_attempt) === String(attempt) &&
      run.repository?.full_name === repository &&
      run.head_branch === 'main' &&
      run.head_sha === pin?.mainSha &&
      ['workflow_dispatch', 'schedule'].includes(run.event) &&
      isTrustedCandidateWorkflowPath(run.path) &&
      run.status === 'in_progress',
    'current candidate workflow run identity is invalid',
  );
  requireValue(
    gitImpl(controlRoot, 'rev-parse', 'HEAD').trim() === pin.mainSha &&
      gitImpl(controlRoot, 'rev-parse', 'HEAD^{tree}').trim() === pin.mainTree,
    'trusted controller checkout differs from pinned main',
  );
  requireValue(
    gitImpl(candidateRoot, 'rev-parse', 'HEAD').trim() === pin.sha &&
      gitImpl(candidateRoot, 'rev-parse', 'HEAD^{tree}').trim() === pin.tree,
    'candidate checkout differs from pinned candidate',
  );
  gitImpl(candidateRoot, 'merge-base', '--is-ancestor', pin.mainSha, pin.sha);
  const migrationHash = hashCandidateMigrations({
    candidateRoot,
    gitImpl,
    readBlob: readBlob ?? ((object) => gitBlob(candidateRoot, object)),
  });
  const before = validateRunnerDbSnapshot(dbBefore, {
    runId,
    attempt,
    migrationHash,
    label: 'before',
  });
  const after = validateRunnerDbSnapshot(dbAfter, {
    runId,
    attempt,
    migrationHash,
    label: 'after',
  });
  requireValue(
    before.identity === after.identity,
    'runner DB identity changed during verification',
  );
  requireValue(
    before.schemaHash === after.schemaHash,
    'runner DB schema changed during verification',
  );
  requireValue(
    timestamp(after.observedAt) >= timestamp(before.observedAt),
    'after DB report predates before DB report',
  );
  const results = suiteResultsFromJobs({ jobsResponse, runId, attempt, headSha: run.head_sha });
  const candidate = createCandidate({ ...pin, db: before });
  assertCandidate({
    candidate,
    results,
    currentMainSha: pin.mainSha,
    actualTree: pin.tree,
    currentDb: after,
    now,
    maxAgeSeconds,
    // The overall run cannot be completed until this seal job and its artifact upload finish.
    // The exact verify job and all suite step conclusions above are already completed in GitHub.
    run: { ...run, status: 'completed', conclusion: 'success' },
  });
  return {
    version: 2,
    candidate,
    results,
    dbAfter: after,
    databaseEvidence: {
      source: 'verification-runner-report',
      migrationContentMatched: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [command, file] = process.argv.slice(2);
    if (command === 'pin') {
      const pin = pinCandidate();
      writeFileSync(file, JSON.stringify(pin, null, 2));
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `sha=${pin.sha}\ntree=${pin.tree}\nmain_sha=${pin.mainSha}\n`,
        );
    } else if (command === 'seal') {
      const pin = JSON.parse(readFileSync(file, 'utf8'));
      const db = JSON.parse(readFileSync(process.argv[4], 'utf8'));
      const dbAfter = JSON.parse(readFileSync(process.argv[5], 'utf8'));
      const repository = process.env.GITHUB_REPOSITORY;
      const runId = process.env.GITHUB_RUN_ID;
      const attempt = process.env.GITHUB_RUN_ATTEMPT;
      const run = gh(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
      const jobsResponse = gh(
        `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      );
      const evidence = sealCandidateEvidence({
        pin,
        dbBefore: db,
        dbAfter,
        run,
        jobsResponse,
        repository,
        runId,
        attempt,
        controlRoot: process.cwd(),
        candidateRoot: process.argv[6],
        maxAgeSeconds: Number(process.env.RELEASE_CANDIDATE_MAX_AGE_SECONDS),
      });
      writeFileSync('candidate-evidence.json', JSON.stringify(evidence, null, 2));
    } else throw new Error('Expected pin or seal command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate held: unknown error');
    process.exitCode = 1;
  }
}
