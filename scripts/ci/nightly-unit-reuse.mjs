#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_UNIT_JOB_NAME = 'Product unit tests (full)';
const FULL_UNIT_STEP_NAME = 'Run unit tests (full)';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Return the explicit full-test result, or null when this attempt did not run that step. */
export function fullUnitStepResult(jobs) {
  if (!Array.isArray(jobs)) return null;
  const job = jobs.find((candidate) => candidate?.name === FULL_UNIT_JOB_NAME);
  if (!Array.isArray(job?.steps)) return null;
  const step = job.steps.find((candidate) => candidate?.name === FULL_UNIT_STEP_NAME);
  if (!step || step.conclusion === 'skipped') return null;
  return job.conclusion === 'success' && step.conclusion === 'success' ? 'success' : 'failure';
}

/** Return an executed full-test result with its actual step start time. */
export function fullUnitStepEvidence(jobs) {
  const result = fullUnitStepResult(jobs);
  if (result === null) return null;

  const job = jobs.find((candidate) => candidate?.name === FULL_UNIT_JOB_NAME);
  const step = job.steps.find((candidate) => candidate?.name === FULL_UNIT_STEP_NAME);
  const startedAt = Date.parse(step.started_at ?? '');
  const completedAt = step.completed_at == null ? null : Date.parse(step.completed_at);
  if (!Number.isFinite(startedAt) || (completedAt !== null && !Number.isFinite(completedAt))) {
    throw new Error('full-unit step is missing a valid started_at or completed_at timestamp');
  }
  if (step.conclusion !== null && completedAt === null) {
    throw new Error('completed full-unit step is missing a valid completed_at timestamp');
  }

  return { result, startedAt, completedAt };
}

/** A successful check requires both the job and the explicit full-test step to succeed. */
export function hasSuccessfulFullUnitStep(jobs) {
  return fullUnitStepResult(jobs) === 'success';
}

/** Manual runs always repeat the full suite; scheduled runs may reuse explicit evidence. */
export function shouldRunFullUnitNow({ eventName, previousSuccessfulRun }) {
  return eventName !== 'schedule' || previousSuccessfulRun !== true;
}

function readJsonLines(args, execImpl = execFileSync) {
  const output = execImpl('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Find the most recently started full-unit step across all runs of the same workflow and SHA.
 * A newer skipped attempt does not replace evidence; an executed failure does. API failure is
 * handled by caller.
 */
export function hasPreviousSuccessfulFullUnitRun({
  repository,
  headSha,
  currentRunId,
  execImpl = execFileSync,
}) {
  if (!REPOSITORY_PATTERN.test(repository ?? '') || !SHA_PATTERN.test(headSha ?? '')) {
    throw new Error('repository or head SHA is invalid');
  }
  const runs = readJsonLines(
    [
      '--paginate',
      `repos/${repository}/actions/workflows/nightly.yml/runs?head_sha=${headSha}&branch=main&per_page=100`,
      '--jq',
      '.workflow_runs[] | @json',
    ],
    execImpl,
  );

  const evidence = [];
  for (const run of runs) {
    if (run?.head_sha !== headSha || String(run?.id ?? '') === String(currentRunId ?? '')) {
      continue;
    }
    if (
      !Number.isSafeInteger(run?.id) ||
      !Number.isSafeInteger(run?.run_attempt) ||
      run.run_attempt < 1
    ) {
      throw new Error('matching workflow run is missing valid id or run_attempt');
    }

    for (let attempt = run.run_attempt; attempt >= 1; attempt -= 1) {
      const jobs = readJsonLines(
        [
          `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
          '--jq',
          '.jobs[] | @json',
        ],
        execImpl,
      );
      const result = fullUnitStepEvidence(jobs);
      if (result) {
        evidence.push(result);
        break;
      }
    }
  }
  if (evidence.length === 0) return false;

  const latestStart = Math.max(...evidence.map((item) => item.startedAt));
  const latestByStart = evidence.filter((item) => item.startedAt === latestStart);
  if (latestByStart.some((item) => item.completedAt === null)) return false;

  const latestCompletion = Math.max(...latestByStart.map((item) => item.completedAt));
  return latestByStart
    .filter((item) => item.completedAt === latestCompletion)
    .every((item) => item.result === 'success');
}

function appendOutput(path, name, value) {
  if (path) appendFileSync(path, `${name}=${value}\n`);
}

function appendSummary(path, markdown) {
  if (path) appendFileSync(path, `${markdown}\n`);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  let previousSuccessfulRun = false;
  let reason = 'manual or non-scheduled run forces the full suite';

  if (eventName === 'schedule') {
    try {
      previousSuccessfulRun = hasPreviousSuccessfulFullUnitRun({
        repository: process.env.GITHUB_REPOSITORY,
        headSha: process.env.GITHUB_SHA,
        currentRunId: process.env.GITHUB_RUN_ID,
      });
      reason = previousSuccessfulRun
        ? 'latest executed full-unit check succeeded for this SHA'
        : 'rerun because no reusable full-unit result exists for this SHA';
    } catch {
      // API/auth/network errors may never be interpreted as successful evidence.
      previousSuccessfulRun = false;
      // Keep raw CLI/API errors out of workflow logs and summaries.
      reason = 'run full suite because prior-run evidence is unavailable (API/auth/network error)';
    }
  }

  const runFull = shouldRunFullUnitNow({ eventName, previousSuccessfulRun });
  appendOutput(process.env.GITHUB_OUTPUT, 'run_full_tests', String(runFull));
  appendSummary(
    process.env.GITHUB_STEP_SUMMARY,
    `## Nightly full-unit reuse\n\n- ${runFull ? 'Run full suite' : 'Skip full suite'}: ${reason}`,
  );
  console.log(`${runFull ? 'Run' : 'Skip'} full unit tests: ${reason}`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  await main();
}
