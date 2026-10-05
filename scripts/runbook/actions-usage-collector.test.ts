import { describe, expect, it, vi } from 'vitest';

import {
  collectActionsUsage,
  estimateJobUsage,
  parseUsageArgs,
} from './actions-usage-collector.mjs';

const instant = Date.parse('2026-09-28T12:00:00.000Z');
const start = '2026-09-28T11:00:00.000Z';

function job(name: string, runner: string, durationSeconds: number, conclusion = 'success') {
  return {
    name,
    labels: [runner],
    started_at: start,
    completed_at: new Date(Date.parse(start) + durationSeconds * 1000).toISOString(),
    conclusion,
  };
}

function apiFor(jobsByRun: Record<number, unknown[]>, runCount = Object.keys(jobsByRun).length) {
  return vi.fn(async (path: string) => {
    if (path.includes('/actions/workflows?')) {
      return { workflows: [{ id: 10, name: 'CI' }] };
    }
    if (path.includes('/workflows/10/runs?')) {
      return {
        total_count: runCount,
        workflow_runs: Object.keys(jobsByRun).map((id) => ({ id: Number(id) })),
      };
    }
    const runId = Number(path.match(/\/runs\/(\d+)\/jobs/)?.[1]);
    const jobs = jobsByRun[runId] ?? [];
    return { total_count: jobs.length, jobs };
  });
}

describe('Actions usage collector argument defaults', () => {
  it('uses the last seven complete UTC days by default', () => {
    expect(parseUsageArgs([], new Date('2026-09-28T00:15:00.000Z'))).toMatchObject({
      since: '2026-09-21',
      until: '2026-09-27',
      maxApiCalls: 2000,
      maxSeconds: 900,
    });
  });

  it.each([
    ['--max-api-calls', '0'],
    ['--max-api-calls', '1.5'],
    ['--max-seconds', '-1'],
  ])('rejects invalid limits %s %s', (option, value) => {
    expect(() => parseUsageArgs([option, value])).toThrow('positive integer');
  });
});

describe('estimateJobUsage', () => {
  it('rounds each started job to a full runner minute and applies OS multipliers', () => {
    expect(estimateJobUsage(job('linux', 'ubuntu-24.04', 61))).toMatchObject({
      runnerMinutes: 2,
      minutes: 2,
      multiplier: 1,
    });
    expect(estimateJobUsage(job('windows', 'windows-2025', 1))).toMatchObject({
      runnerMinutes: 1,
      minutes: 2,
      multiplier: 2,
    });
    expect(estimateJobUsage(job('macos', 'macos-15', 1))).toMatchObject({
      runnerMinutes: 1,
      minutes: 10,
      multiplier: 10,
    });
    expect(estimateJobUsage({ started_at: null })).toMatchObject({
      state: 'no-runner',
      minutes: 0,
    });
    expect(estimateJobUsage(job('self-hosted', 'self-hosted', 60))).toMatchObject({
      state: 'self-hosted',
      minutes: 0,
    });
  });
});

describe('collectActionsUsage', () => {
  const range = { repository: 'Dayopt/dayopt', since: '2026-09-28', until: '2026-09-28' };

  it('collects all run jobs, including canceled started jobs, and excludes no-runner/self-hosted minutes', async () => {
    const apiImpl = apiFor({
      1: [
        job('Unit', 'ubuntu-24.04', 61),
        job('Unit', 'windows-2025', 10),
        job('Unit', 'ubuntu-24.04', 30, 'cancelled'),
        { name: 'Unit', labels: ['ubuntu-24.04'], started_at: null, completed_at: null },
        job('Self hosted', 'self-hosted', 60),
      ],
      2: [],
    });

    const report = await collectActionsUsage({ ...range, apiImpl, nowImpl: () => instant });

    expect(report).toMatchObject({
      partial: false,
      workflowsSeen: 1,
      runsSeen: 2,
      totalMinutes: 5,
      projected30DayMinutes: 150,
      noRunnerJobs: 1,
      cancelledJobs: 1,
      unknownRunnerJobs: 0,
      inProgressJobs: 0,
    });
    expect(report.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'CI',
          job: 'Unit',
          jobAttempts: 4,
          allocatedJobs: 3,
          runnerMinutes: 4,
          minutes: 5,
          cancelledJobs: 1,
          cancelledMinutes: 1,
          noRunnerJobs: 1,
        }),
        expect.objectContaining({ job: 'Self hosted', selfHostedJobs: 1, minutes: 0 }),
      ]),
    );
    expect(apiImpl).toHaveBeenCalledTimes(4);
  });

  it('marks an unexpectedly short run page partial instead of treating it as complete', async () => {
    const apiImpl = vi.fn(async (path: string) => {
      if (path.includes('/actions/workflows?')) return { workflows: [{ id: 10, name: 'CI' }] };
      return { total_count: 2, workflow_runs: [{ id: 1 }] };
    });

    const report = await collectActionsUsage({ ...range, apiImpl, nowImpl: () => instant });

    expect(report.partial).toBe(true);
    expect(report.partialReasons).toContain(
      'run pagination ended before total_count: CI 2026-09-28',
    );
    expect(apiImpl).toHaveBeenCalledTimes(3);
  });

  it('marks an unexpectedly short job page partial instead of treating it as complete', async () => {
    const apiImpl = vi.fn(async (path: string) => {
      if (path.includes('/actions/workflows?')) return { workflows: [{ id: 10, name: 'CI' }] };
      if (path.includes('/workflows/10/runs?'))
        return { total_count: 1, workflow_runs: [{ id: 1 }] };
      return { total_count: 2, jobs: [job('Unit', 'ubuntu-24.04', 60)] };
    });

    const report = await collectActionsUsage({ ...range, apiImpl, nowImpl: () => instant });

    expect(report.partial).toBe(true);
    expect(report.partialReasons).toContain('job pagination ended before total_count: CI run 1');
  });

  it('counts transient retries against the API request ceiling', async () => {
    const apiImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce({ workflows: [] });
    const report = await collectActionsUsage({
      ...range,
      apiImpl,
      nowImpl: () => instant,
      sleepImpl: async () => {},
      maxApiCalls: 1,
    });

    expect(report.apiCalls).toBe(1);
    expect(apiImpl).toHaveBeenCalledTimes(1);
    expect(report.partial).toBe(true);
    expect(report.partialReasons).toContain('API request ceiling reached (1)');
  });

  it('returns a partial report without making requests when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const apiImpl = vi.fn();
    const report = await collectActionsUsage({
      ...range,
      apiImpl,
      nowImpl: () => instant,
      signal: controller.signal,
    });

    expect(report.partial).toBe(true);
    expect(report.partialReasons).toContain('cancelled by user');
    expect(apiImpl).not.toHaveBeenCalled();
  });

  it('aborts an in-flight API request and returns a partial report', async () => {
    const controller = new AbortController();
    const apiImpl = vi.fn(
      (_path: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const collection = collectActionsUsage({
      ...range,
      apiImpl,
      nowImpl: () => instant,
      signal: controller.signal,
    });

    controller.abort();
    const report = await collection;

    expect(report.partial).toBe(true);
    expect(report.partialReasons).toContain('cancelled by user');
    expect(report.apiCalls).toBe(1);
    expect(apiImpl).toHaveBeenCalledTimes(1);
  });
});
