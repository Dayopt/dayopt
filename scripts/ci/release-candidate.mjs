import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

export const CANDIDATE_SUITES = ['unit', 'integration', 'db_upgrade', 'e2e', 'web', 'storybook'];
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const positiveId = /^[1-9][0-9]*$/;

function requireValue(condition, detail) {
  if (!condition) throw new Error(`Candidate held: ${detail}`);
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
      run.path === '.github/workflows/release-candidate.yml' &&
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
      const results = JSON.parse(process.env.CANDIDATE_RESULTS ?? '{}');
      const candidate = createCandidate({ ...pin, db });
      for (const suite of CANDIDATE_SUITES)
        requireValue(results[suite] === 'success', `${suite} is not green`);
      for (const key of ['identity', 'migrationHash', 'schemaHash'])
        requireValue(dbAfter[key] === db[key], `DB ${key} changed during tests`);
      writeFileSync(
        'candidate-evidence.json',
        JSON.stringify({ candidate, results, dbAfter }, null, 2),
      );
    } else throw new Error('Expected pin or seal command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate held: unknown error');
    process.exitCode = 1;
  }
}
