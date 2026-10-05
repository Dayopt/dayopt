import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCandidateHeartbeat } from './release-candidate-heartbeat.mjs';
import { CANDIDATE_SUITES } from './release-candidate.mjs';

const repository = 'Dayopt/dayopt';
const runId = 12345;
const attempt = 2;
const sha = 'a'.repeat(40);
const candidateSha = '7'.repeat(40);
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
  path: '.github/workflows/release-candidate.yml@main',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  sha: candidateSha,
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
    version: 2,
    candidate: recordedCandidate,
    results: Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success'])),
    dbAfter: {
      identity: (recordedCandidate.db as { identity: string }).identity,
      migrationHash,
      schemaHash,
    },
    databaseEvidence: {
      source: 'verification-runner-report',
      migrationContentMatched: true,
    },
  };
};

function setup({
  latest = run(),
  artifact = validEvidence(),
  olderGreen = run({ id: 12344 }),
  currentMainSha = sha,
  nextMainSha = currentMainSha,
  candidateCommit = { sha: candidateSha, commit: { tree: { sha: tree } } },
  mainCommit = {
    sha: currentMainSha,
    commit: { tree: { sha: tree } },
    parents: [{ sha }, { sha: candidateSha }],
  },
}: {
  latest?: ReturnType<typeof run> | null;
  artifact?: unknown | null;
  olderGreen?: ReturnType<typeof run> | null;
  currentMainSha?: string | null;
  nextMainSha?: string | null;
  candidateCommit?: Record<string, unknown>;
  mainCommit?: Record<string, unknown>;
} = {}) {
  const calls: string[] = [];
  const downloads: Array<[string, string]> = [];
  let mainRefReads = 0;
  const api = (path: string) => {
    calls.push(path);
    if (
      path ===
      `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`
    ) {
      return { workflow_runs: latest ? [latest, olderGreen].filter(Boolean) : [] };
    }
    if (path === `repos/${repository}/git/ref/heads/main`) {
      const sha = mainRefReads++ === 0 ? currentMainSha : nextMainSha;
      return sha ? { object: { sha } } : { object: {} };
    }
    if (path === `repos/${repository}/commits/${candidateSha}`) return candidateCommit;
    if (path === `repos/${repository}/commits/${currentMainSha}`) return mainCommit;
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

    expect(result.sha).toBe(candidateSha);
    expect(result.heartbeatStatus).toBe('fresh');
    expect(result.reusable).toBe(true);
    expect(fixture.calls).toEqual([
      `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`,
      `repos/${repository}/commits/${candidateSha}`,
      `repos/${repository}/git/ref/heads/main`,
      `repos/${repository}/git/ref/heads/main`,
    ]);
    expect(fixture.downloads).toEqual([[String(runId), `candidate-evidence-${attempt}`]]);
  });

  it('reports consumed evidence only when current main is the exact two-parent candidate merge', () => {
    const promotedMainSha = '9'.repeat(40);
    const fixture = setup({
      currentMainSha: promotedMainSha,
      mainCommit: {
        sha: promotedMainSha,
        commit: {
          tree: { sha: tree },
        },
        parents: [{ sha }, { sha: candidateSha }],
      },
    });

    const result = checkCandidateHeartbeat({
      repository,
      maxAgeSeconds: 3600,
      now,
      ...fixture,
    });

    expect(result).toMatchObject({
      sha: candidateSha,
      heartbeatStatus: 'main-merged',
      reusable: false,
    });
    expect(fixture.calls).toContain(`repos/${repository}/commits/${promotedMainSha}`);
  });

  it('rejects a main hotfix or unrelated merge after candidate capture', () => {
    const advancedMainSha = '9'.repeat(40);
    const fixture = setup({
      currentMainSha: advancedMainSha,
      mainCommit: {
        sha: advancedMainSha,
        commit: {
          tree: { sha: tree },
        },
        parents: [{ sha }, { sha: '8'.repeat(40) }],
      },
    });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow('main advanced beyond this candidate');
    expect(fixture.calls).toContain(`repos/${repository}/commits/${advancedMainSha}`);
  });

  it.each([
    ['missing', null],
    ['invalid', 'not-a-full-sha'],
  ])('fails closed when current main SHA is %s', (_label, mainSha) => {
    const fixture = setup({ currentMainSha: mainSha as string | null });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow('current main SHA is unknown');
    expect(fixture.calls).toEqual([
      `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`,
      `repos/${repository}/commits/${candidateSha}`,
      `repos/${repository}/git/ref/heads/main`,
    ]);
  });

  it('rejects main moving from the candidate baseline during heartbeat verification', () => {
    const fixture = setup({ currentMainSha: sha, nextMainSha: '9'.repeat(40) });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow('main changed while heartbeat evidence was checked');
    expect(fixture.calls.filter((path) => path.endsWith('/git/ref/heads/main'))).toHaveLength(2);
  });

  it('rejects a candidate tree that does not match the repository commit', () => {
    const fixture = setup({
      candidateCommit: { sha: candidateSha, commit: { tree: { sha: '8'.repeat(40) } } },
    });

    expect(() =>
      checkCandidateHeartbeat({ repository, maxAgeSeconds: 3600, now, ...fixture }),
    ).toThrow('candidate commit tree differs');
    expect(fixture.calls).toEqual([
      `repos/${repository}/actions/workflows/release-candidate.yml/runs?branch=main&per_page=1`,
      `repos/${repository}/commits/${candidateSha}`,
    ]);
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
