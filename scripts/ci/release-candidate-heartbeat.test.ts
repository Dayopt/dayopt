import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCandidateHeartbeat } from './release-candidate-heartbeat.mjs';
import { CANDIDATE_SUITES } from './release-candidate.mjs';

const repository = 'Dayopt/dayopt';
const runId = 12345;
const attempt = 2;
const sha = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const migrationHash = 'e'.repeat(64);
const schemaHash = 'f'.repeat(64);
const now = new Date().toISOString();
const capturedAt = new Date(Date.now() - 1000).toISOString();
const observedAt = now;

const run = (overrides: Record<string, unknown> = {}) => ({
  id: runId,
  run_attempt: attempt,
  repository: { full_name: repository },
  head_branch: 'main',
  head_sha: sha,
  path: '.github/workflows/release-candidate.yml',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  sha,
  tree,
  mainSha: sha,
  mainTree: 'd'.repeat(40),
  runId: String(runId),
  attempt: String(attempt),
  capturedAt,
  db: {
    identity: `runner:${runId}:${attempt}`,
    migrationHash,
    schemaHash,
    observedAt,
  },
  ...overrides,
});

const validEvidence = (candidateOverride: Record<string, unknown> = {}) => {
  const recordedCandidate = candidate(candidateOverride);
  return {
    candidate: recordedCandidate,
    results: Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success'])),
    dbAfter: {
      identity: (recordedCandidate.db as { identity: string }).identity,
      migrationHash,
      schemaHash,
    },
  };
};

function setup({
  latest = run(),
  artifact = validEvidence(),
  olderGreen = run({ id: 12344 }),
}: {
  latest?: ReturnType<typeof run> | null;
  artifact?: unknown | null;
  olderGreen?: ReturnType<typeof run> | null;
} = {}) {
  const calls: string[] = [];
  const downloads: Array<[string, string]> = [];
  const api = (path: string) => {
    calls.push(path);
    if (
      path ===
      `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`
    ) {
      return { workflow_runs: latest ? [latest, olderGreen].filter(Boolean) : [] };
    }
    throw new Error(`Unexpected API call: ${path}`);
  };
  const download = (id: string, name: string, dir: string) => {
    downloads.push([id, name]);
    if (artifact !== null)
      writeFileSync(join(dir, 'candidate-evidence.json'), JSON.stringify(artifact));
  };
  return { api, calls, download, downloads };
}

describe('release candidate heartbeat', () => {
  it('accepts fresh evidence from the latest successful candidate run', () => {
    const fixture = setup();

    const result = checkCandidateHeartbeat({
      repository,
      maxAgeSeconds: 3600,
      now,
      ...fixture,
    });

    expect(result.sha).toBe(sha);
    expect(fixture.downloads).toEqual([[String(runId), `candidate-evidence-${attempt}`]]);
  });

  it.each([
    ['missing', { latest: null }],
    ['red', { latest: run({ conclusion: 'failure' }) }],
    ['unfinished', { latest: run({ status: 'in_progress', conclusion: null }) }],
  ])('rejects the latest %s run even when an older run is green', (_label, options) => {
    const fixture = setup(options as Parameters<typeof setup>[0]);

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.downloads).toEqual([]);
  });

  it('rejects missing artifact evidence instead of reusing an older candidate', () => {
    const fixture = setup({ artifact: null });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow();
    expect(fixture.downloads).toEqual([[String(runId), `candidate-evidence-${attempt}`]]);
  });

  it('rejects stale evidence from the latest run', () => {
    const staleCapture = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fixture = setup({ artifact: validEvidence({ capturedAt: staleCapture }) });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow();
    expect(fixture.downloads).toEqual([[String(runId), `candidate-evidence-${attempt}`]]);
  });

  it('rejects evidence from an older attempt of the same run', () => {
    const priorAttempt = 1;
    const fixture = setup({
      artifact: validEvidence({
        attempt: String(priorAttempt),
        db: {
          identity: `runner:${runId}:${priorAttempt}`,
          migrationHash,
          schemaHash,
          observedAt,
        },
      }),
    });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow();
    expect(fixture.downloads).toEqual([[String(runId), `candidate-evidence-${attempt}`]]);
  });
});
