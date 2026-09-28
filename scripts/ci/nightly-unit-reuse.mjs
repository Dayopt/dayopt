#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_UNIT_JOB_NAME = 'Product unit tests (full)';
const FULL_UNIT_STEP_NAME = 'Run unit tests (full)';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A successful check requires both the job and the explicit full-test step to succeed. */
export function hasSuccessfulFullUnitStep(jobs) {
  return (
    Array.isArray(jobs) &&
    jobs.some(
      (job) =>
        job?.name === FULL_UNIT_JOB_NAME &&
        job?.conclusion === 'success' &&
        Array.isArray(job.steps) &&
        job.steps.some(
          (step) => step?.name === FULL_UNIT_STEP_NAME && step?.conclusion === 'success',
        ),
    )
  );
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

/** Search only earlier runs of the same workflow and SHA. API failure is handled by caller. */
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
      `repos/${repository}/actions/workflows/nightly.yml/runs?head_sha=${headSha}&branch=main&per_page=100`,
      '--jq',
      '.workflow_runs[] | @json',
    ],
    execImpl,
  );

  for (const run of runs) {
    if (
      run?.head_sha !== headSha ||
      String(run?.id ?? '') === String(currentRunId ?? '') ||
      !Number.isSafeInteger(run?.run_attempt) ||
      !Number.isSafeInteger(run?.id)
    ) {
      continue;
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
      if (hasSuccessfulFullUnitStep(jobs)) return true;
    }
  }
  return false;
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
        ? 'same SHA has a successful full-unit run'
        : 'no successful full-unit run exists for this SHA';
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
