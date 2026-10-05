#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const DEFAULT_MAX_API_CALLS = 2_000;
const DEFAULT_MAX_SECONDS = 900;
const MAX_PAGES_PER_PARTITION = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STOP_COLLECTION = Symbol('stop-collection');
const execFileAsync = promisify(execFile);

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value, name) {
  if (!DATE_PATTERN.test(value ?? '') || dateString(new Date(`${value}T00:00:00.000Z`)) !== value) {
    throw new Error(`${name} must be a real UTC date in YYYY-MM-DD format`);
  }
  return value;
}

function defaultWindow(now = new Date()) {
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000,
  );
  const since = new Date(until.getTime() - 6 * 86_400_000);
  return { since: dateString(since), until: dateString(until) };
}

export function parseUsageArgs(argv, now = new Date()) {
  const defaults = defaultWindow(now);
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? 'Dayopt/dayopt',
    since: defaults.since,
    until: defaults.until,
    maxApiCalls: DEFAULT_MAX_API_CALLS,
    maxSeconds: DEFAULT_MAX_SECONDS,
    outputPath: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    if (name === '--repo') options.repository = value;
    else if (name === '--since') options.since = parseDate(value, '--since');
    else if (name === '--until') options.until = parseDate(value, '--until');
    else if (name === '--max-api-calls') options.maxApiCalls = Number(value);
    else if (name === '--max-seconds') options.maxSeconds = Number(value);
    else if (name === '--out') options.outputPath = value;
    else throw new Error(`unknown option: ${name}`);
    index += 1;
  }

  if (!REPOSITORY_PATTERN.test(options.repository))
    throw new Error('--repo must be OWNER/REPOSITORY');
  if (options.since > options.until) throw new Error('--since must be on or before --until');
  if (!Number.isSafeInteger(options.maxApiCalls) || options.maxApiCalls < 1) {
    throw new Error('--max-api-calls must be a positive integer');
  }
  if (!Number.isSafeInteger(options.maxSeconds) || options.maxSeconds < 1) {
    throw new Error('--max-seconds must be a positive integer');
  }
  return options;
}

/** Round each allocated runner job independently, as GitHub does. */
export function estimateJobUsage(job, now = Date.now()) {
  if (!job?.started_at) return { state: 'no-runner', minutes: 0, elapsedSeconds: 0 };

  const startedAt = Date.parse(job.started_at);
  const endedAt = job.completed_at ? Date.parse(job.completed_at) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return { state: 'unknown', minutes: 0, elapsedSeconds: 0 };
  }

  const labels = Array.isArray(job.labels)
    ? job.labels.filter((label) => typeof label === 'string')
    : [];
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  if (normalizedLabels.includes('self-hosted')) {
    return {
      state: 'self-hosted',
      minutes: 0,
      elapsedSeconds: Math.ceil((endedAt - startedAt) / 1000),
    };
  }

  let multiplier;
  if (normalizedLabels.some((label) => /^ubuntu-(?:latest|\d{2}\.\d{2})$/.test(label)))
    multiplier = 1;
  else if (
    normalizedLabels.some((label) => /^ubuntu-(?:\d{2}\.\d{2}-arm|\d{2}\.\d{2}-arm64)$/.test(label))
  )
    multiplier = 1;
  else if (normalizedLabels.some((label) => /^windows-(?:latest|\d{4})$/.test(label)))
    multiplier = 2;
  else if (normalizedLabels.some((label) => /^macos-(?:latest|\d{2}|\d{2}-intel)$/.test(label)))
    multiplier = 10;
  else
    return {
      state: 'unknown',
      minutes: 0,
      elapsedSeconds: Math.ceil((endedAt - startedAt) / 1000),
    };

  const elapsedSeconds = Math.ceil((endedAt - startedAt) / 1000);
  const runnerMinutes = Math.max(1, Math.ceil(elapsedSeconds / 60));
  return {
    state: job.completed_at ? 'completed' : 'in-progress',
    elapsedSeconds,
    runnerMinutes,
    minutes: runnerMinutes * multiplier,
    multiplier,
    cancelled: job.conclusion === 'cancelled',
  };
}

function createBucket(map, workflow, jobName) {
  const key = `${workflow}\u0000${jobName}`;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      workflow,
      job: jobName,
      jobAttempts: 0,
      allocatedJobs: 0,
      minutes: 0,
      runnerMinutes: 0,
      cancelledMinutes: 0,
      cancelledJobs: 0,
      selfHostedJobs: 0,
      noRunnerJobs: 0,
      unknownRunnerJobs: 0,
      inProgressJobs: 0,
    };
    map.set(key, bucket);
  }
  return bucket;
}

function daysInRange(since, until) {
  const days = [];
  for (
    let day = new Date(`${since}T00:00:00.000Z`);
    dateString(day) <= until;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    days.push(dateString(day));
  }
  return days;
}

/**
 * Collect job histories through an injected read-only API function.
 * @param {{ repository: string, since: string, until: string, maxApiCalls?: number, maxSeconds?: number, apiImpl: (path: string, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<any> | any, nowImpl?: () => number, sleepImpl?: (milliseconds: number, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal }} options
 */
export async function collectActionsUsage({
  repository,
  since,
  until,
  maxApiCalls = DEFAULT_MAX_API_CALLS,
  maxSeconds = DEFAULT_MAX_SECONDS,
  apiImpl,
  nowImpl = () => Date.now(),
  sleepImpl = sleep,
  signal = undefined,
}) {
  if (!REPOSITORY_PATTERN.test(repository ?? ''))
    throw new Error('repository must be OWNER/REPOSITORY');
  parseDate(since, 'since');
  parseDate(until, 'until');
  if (since > until) throw new Error('since must be on or before until');
  if (!Number.isSafeInteger(maxApiCalls) || maxApiCalls < 1)
    throw new Error('maxApiCalls must be a positive integer');
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1)
    throw new Error('maxSeconds must be a positive integer');
  if (typeof apiImpl !== 'function') throw new Error('apiImpl is required');

  const startedAt = nowImpl();
  const buckets = new Map();
  const partialReasons = [];
  let apiCalls = 0;
  let workflowsSeen = 0;
  let runsSeen = 0;
  let noRunnerJobs = 0;
  let unknownRunnerJobs = 0;
  let inProgressJobs = 0;
  let cancelledJobs = 0;

  async function fetch(path) {
    let retry = 0;
    while (true) {
      if (signal?.aborted) {
        partialReasons.push('cancelled by user');
        throw STOP_COLLECTION;
      }
      const elapsedMs = nowImpl() - startedAt;
      const remainingMs = maxSeconds * 1000 - elapsedMs;
      if (remainingMs <= 0) {
        partialReasons.push(`time ceiling reached (${maxSeconds}s)`);
        throw STOP_COLLECTION;
      }
      if (apiCalls >= maxApiCalls) {
        partialReasons.push(`API request ceiling reached (${maxApiCalls})`);
        throw STOP_COLLECTION;
      }

      apiCalls += 1;
      try {
        return await apiImpl(path, {
          signal,
          timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(1, remainingMs)),
        });
      } catch (error) {
        if (signal?.aborted) {
          partialReasons.push('cancelled by user');
          throw STOP_COLLECTION;
        }
        if (nowImpl() - startedAt >= maxSeconds * 1000) {
          partialReasons.push(`time ceiling reached (${maxSeconds}s)`);
          throw STOP_COLLECTION;
        }
        if (isTransientApiError(error) && retry < RETRY_DELAYS_MS.length) {
          try {
            await sleepImpl(RETRY_DELAYS_MS[retry], signal);
          } catch {
            if (signal?.aborted) {
              partialReasons.push('cancelled by user');
              throw STOP_COLLECTION;
            }
          }
          retry += 1;
          continue;
        }
        partialReasons.push('GitHub API read failed after bounded retries');
        throw STOP_COLLECTION;
      }
    }
  }

  function addJob(workflowName, job) {
    const bucket = createBucket(buckets, workflowName, job?.name ?? '(unnamed job)');
    bucket.jobAttempts += 1;
    const usage = estimateJobUsage(job, nowImpl());
    if (usage.state === 'no-runner') {
      bucket.noRunnerJobs += 1;
      noRunnerJobs += 1;
      return;
    }
    if (usage.state === 'self-hosted') {
      bucket.selfHostedJobs += 1;
      return;
    }
    if (usage.state === 'unknown') {
      bucket.unknownRunnerJobs += 1;
      unknownRunnerJobs += 1;
      partialReasons.push(
        `runner type or job timestamps unavailable: ${workflowName} / ${job?.name ?? '(unnamed job)'}`,
      );
      return;
    }

    bucket.allocatedJobs += 1;
    bucket.minutes += usage.minutes;
    bucket.runnerMinutes += usage.runnerMinutes;
    if (usage.cancelled) {
      bucket.cancelledJobs += 1;
      bucket.cancelledMinutes += usage.minutes;
      cancelledJobs += 1;
    }
    if (usage.state === 'in-progress') {
      bucket.inProgressJobs += 1;
      inProgressJobs += 1;
      partialReasons.push('one or more jobs were still running at collection time');
    }
  }

  try {
    const workflows = [];
    for (let page = 1; page <= MAX_PAGES_PER_PARTITION; page += 1) {
      const response = await fetch(
        `repos/${repository}/actions/workflows?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response?.workflows)) {
        partialReasons.push('workflow list response was malformed');
        throw STOP_COLLECTION;
      }
      workflows.push(...response.workflows);
      if (response.workflows.length < 100) break;
      if (page === MAX_PAGES_PER_PARTITION) {
        partialReasons.push('workflow pagination ceiling reached');
        throw STOP_COLLECTION;
      }
    }
    workflowsSeen = workflows.length;

    for (const workflow of workflows) {
      if (!Number.isSafeInteger(workflow?.id) || typeof workflow?.name !== 'string') {
        partialReasons.push('workflow list contained malformed metadata');
        continue;
      }

      for (const day of daysInRange(since, until)) {
        const workflowRuns = [];
        let totalCount;
        for (let page = 1; page <= MAX_PAGES_PER_PARTITION; page += 1) {
          const response = await fetch(
            `repos/${repository}/actions/workflows/${workflow.id}/runs?created=${day}..${day}&per_page=100&page=${page}`,
          );
          if (
            !Array.isArray(response?.workflow_runs) ||
            !Number.isSafeInteger(response?.total_count)
          ) {
            partialReasons.push(`workflow runs response was malformed: ${workflow.name} ${day}`);
            throw STOP_COLLECTION;
          }
          totalCount = response.total_count;
          workflowRuns.push(...response.workflow_runs);
          if (workflowRuns.length >= totalCount) break;
          if (page === MAX_PAGES_PER_PARTITION) {
            partialReasons.push(`run pagination ceiling reached: ${workflow.name} ${day}`);
            break;
          }
          if (response.workflow_runs.length < 100) {
            partialReasons.push(`run pagination ended before total_count: ${workflow.name} ${day}`);
            break;
          }
        }

        if (totalCount >= MAX_PAGES_PER_PARTITION * 100) {
          partialReasons.push(
            `partition reached GitHub's 1,000-run search ceiling: ${workflow.name} ${day}`,
          );
        }
        runsSeen += workflowRuns.length;

        for (const run of workflowRuns) {
          if (!Number.isSafeInteger(run?.id)) {
            partialReasons.push(`run list contained malformed metadata: ${workflow.name} ${day}`);
            continue;
          }
          for (let page = 1; page <= MAX_PAGES_PER_PARTITION; page += 1) {
            const response = await fetch(
              `repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
            );
            if (!Array.isArray(response?.jobs) || !Number.isSafeInteger(response?.total_count)) {
              partialReasons.push(
                `job list response was malformed: ${workflow.name} run ${run.id}`,
              );
              throw STOP_COLLECTION;
            }
            for (const job of response.jobs) addJob(workflow.name, job);
            if (response.jobs.length >= response.total_count) break;
            if (page === MAX_PAGES_PER_PARTITION) {
              partialReasons.push(`job pagination ceiling reached: ${workflow.name} run ${run.id}`);
              break;
            }
            if (response.jobs.length < 100) {
              partialReasons.push(
                `job pagination ended before total_count: ${workflow.name} run ${run.id}`,
              );
              break;
            }
          }
          if (apiCalls >= maxApiCalls || nowImpl() - startedAt >= maxSeconds * 1000) break;
        }
        if (apiCalls >= maxApiCalls || nowImpl() - startedAt >= maxSeconds * 1000)
          throw STOP_COLLECTION;
      }
    }
  } catch (error) {
    if (error !== STOP_COLLECTION) throw error;
  }

  const jobTotals = [...buckets.values()].sort(
    (left, right) =>
      right.minutes - left.minutes ||
      left.workflow.localeCompare(right.workflow) ||
      left.job.localeCompare(right.job),
  );
  const totalMinutes = jobTotals.reduce((sum, job) => sum + job.minutes, 0);
  const periodDays = daysInRange(since, until).length;
  return {
    repository,
    window: { since, until, days: periodDays },
    collectedAt: new Date(nowImpl()).toISOString(),
    apiCalls,
    limits: { maxApiCalls, maxSeconds },
    workflowsSeen,
    runsSeen,
    totalMinutes,
    projected30DayMinutes: Math.ceil((totalMinutes / periodDays) * 30),
    noRunnerJobs,
    unknownRunnerJobs,
    inProgressJobs,
    cancelledJobs,
    partial: partialReasons.length > 0,
    partialReasons: [...new Set(partialReasons)],
    jobs: jobTotals,
  };
}

function appendToFile(path, body) {
  if (path) appendFileSync(path, body);
}

function sleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTransientApiError(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error?.stderr ?? '');
  const message = String(error?.message ?? '');
  return /HTTP (?:429|5\d\d)|rate limit|secondary rate|timed out|ETIMEDOUT|ECONNRESET|EPIPE|SIGTERM/i.test(
    `${stderr}\n${message}`,
  );
}

async function ghApi(path, { signal, timeoutMs }) {
  const { stdout } = await execFileAsync('gh', ['api', path], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    signal,
  });
  return JSON.parse(stdout);
}

function helpText() {
  return [
    'Read-only GitHub Actions per-job usage estimate (no workflow is started).',
    'Usage: node scripts/ci/actions-usage-collector.mjs [--repo OWNER/REPOSITORY] [--since YYYY-MM-DD] [--until YYYY-MM-DD]',
    '       [--max-api-calls N] [--max-seconds N] [--out FILE]',
    `Defaults: last 7 complete UTC days, ${DEFAULT_MAX_API_CALLS} API calls, ${DEFAULT_MAX_SECONDS}s.`,
    'Split larger windows into smaller date ranges; partial reports are not safe for a budget decision.',
  ].join('\n');
}

async function main() {
  const options = parseUsageArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const report = await collectActionsUsage({
      repository: options.repository,
      since: options.since,
      until: options.until,
      maxApiCalls: options.maxApiCalls,
      maxSeconds: options.maxSeconds,
      apiImpl: ghApi,
      signal: controller.signal,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath)
      writeFileSync(options.outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
    else process.stdout.write(serialized);
    appendToFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Actions usage collection\n\n- Window: ${options.since} through ${options.until} UTC\n- Estimate: ${report.totalMinutes} runner-weighted minutes; 30-day projection ${report.projected30DayMinutes}\n- API requests: ${report.apiCalls}\n- Partial: ${report.partial ? 'yes' : 'no'}\n`,
    );
    if (report.partial) process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
