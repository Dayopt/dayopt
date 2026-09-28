import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasPreviousSuccessfulFullUnitRun,
  hasSuccessfulFullUnitStep,
  shouldRunFullUnitNow,
} from './nightly-unit-reuse.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('hasSuccessfulFullUnitStep', () => {
  it('requires the exact full-unit job and named test step to succeed', () => {
    expect(
      hasSuccessfulFullUnitStep([
        {
          name: 'Product unit tests (full)',
          conclusion: 'success',
          steps: [{ name: 'Run unit tests (full)', conclusion: 'success' }],
        },
      ]),
    ).toBe(true);
  });

  it.each([
    { jobs: [] },
    {
      jobs: [
        {
          name: 'Product unit tests (full)',
          conclusion: 'failure',
          steps: [{ name: 'Run unit tests (full)', conclusion: 'success' }],
        },
      ],
    },
    {
      jobs: [
        {
          name: 'Product unit tests (full)',
          conclusion: 'success',
          steps: [{ name: 'Run unit tests (related)', conclusion: 'success' }],
        },
      ],
    },
    {
      jobs: [
        {
          name: 'Other job',
          conclusion: 'success',
          steps: [{ name: 'Run unit tests (full)', conclusion: 'success' }],
        },
      ],
    },
  ])('rejects incomplete or differently named evidence: $jobs', ({ jobs }) => {
    expect(hasSuccessfulFullUnitStep(jobs)).toBe(false);
  });
});

describe('shouldRunFullUnitNow', () => {
  it('skips only scheduled runs with explicit same-SHA success evidence', () => {
    expect(shouldRunFullUnitNow({ eventName: 'schedule', previousSuccessfulRun: true })).toBe(
      false,
    );
    expect(shouldRunFullUnitNow({ eventName: 'schedule', previousSuccessfulRun: false })).toBe(
      true,
    );
    expect(
      shouldRunFullUnitNow({ eventName: 'workflow_dispatch', previousSuccessfulRun: true }),
    ).toBe(true);
    expect(shouldRunFullUnitNow({ eventName: 'push', previousSuccessfulRun: true })).toBe(true);
  });
});

describe('hasPreviousSuccessfulFullUnitRun', () => {
  it('ignores the current run and other SHAs, then accepts a prior exact successful full-unit run', () => {
    const execImpl = vi.fn((_: string, args: string[]) => {
      const apiPath = args[1];
      if (apiPath.includes('/workflows/nightly.yml/runs?')) {
        return [
          { id: 101, head_sha: 'a'.repeat(40), run_attempt: 1 },
          { id: 100, head_sha: 'b'.repeat(40), run_attempt: 1 },
          { id: 99, head_sha: 'a'.repeat(40), run_attempt: 2 },
        ]
          .map((run) => JSON.stringify(run))
          .join('\n');
      }
      if (apiPath.includes('/runs/99/attempts/2/jobs?')) {
        return JSON.stringify({
          name: 'Product unit tests (full)',
          conclusion: 'success',
          steps: [{ name: 'Run unit tests (full)', conclusion: 'success' }],
        });
      }
      throw new Error(`unexpected API path: ${apiPath}`);
    });

    expect(
      hasPreviousSuccessfulFullUnitRun({
        repository: 'Dayopt/dayopt',
        headSha: 'a'.repeat(40),
        currentRunId: '101',
        execImpl: execImpl as unknown as typeof execFileSync,
      }),
    ).toBe(true);
    expect(execImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a different SHA and propagates API errors so the caller must run full', () => {
    const noMatchingRun = vi.fn(() =>
      JSON.stringify({ id: 99, head_sha: 'b'.repeat(40), run_attempt: 1 }),
    );
    expect(
      hasPreviousSuccessfulFullUnitRun({
        repository: 'Dayopt/dayopt',
        headSha: 'a'.repeat(40),
        currentRunId: '101',
        execImpl: noMatchingRun as unknown as typeof execFileSync,
      }),
    ).toBe(false);
    expect(() =>
      hasPreviousSuccessfulFullUnitRun({
        repository: 'Dayopt/dayopt',
        headSha: 'a'.repeat(40),
        currentRunId: '101',
        execImpl: (() => {
          throw new Error('unavailable');
        }) as typeof execFileSync,
      }),
    ).toThrow('unavailable');
  });
});

describe('nightly unit reuse CLI', () => {
  it('writes a valid output and Markdown summary without key-value syntax in the summary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightly-unit-reuse-'));
    scratchDirectories.push(directory);
    const outputPath = join(directory, 'output');
    const summaryPath = join(directory, 'summary');
    writeFileSync(outputPath, '');
    writeFileSync(summaryPath, '');

    const result = spawnSync(process.execPath, ['scripts/ci/nightly-unit-reuse.mjs'], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe('run_full_tests=true\n');
    expect(readFileSync(summaryPath, 'utf8')).toContain(
      'Run full suite: manual or non-scheduled run forces the full suite',
    );
    expect(readFileSync(summaryPath, 'utf8')).not.toContain('summary=');
  });
});
