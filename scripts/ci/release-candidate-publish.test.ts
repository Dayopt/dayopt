import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { publishCandidate } from './release-candidate-publish.mjs';
import { CANDIDATE_SUITES } from './release-candidate.mjs';

const repository = 'Dayopt/dayopt';
const runId = '12345';
const attempt = 2;
const mainSha = 'c'.repeat(40);
const mainTree = 'd'.repeat(40);
const candidateSha = 'a'.repeat(40);
const candidateTree = 'b'.repeat(40);
const migrationHash = 'e'.repeat(64);
const schemaHash = 'f'.repeat(64);
const now = new Date().toISOString();
const observedAt = now;

const candidate = () => ({
  version: 1,
  sha: candidateSha,
  tree: candidateTree,
  mainSha,
  mainTree,
  runId,
  attempt: String(attempt),
  capturedAt: now,
  db: { identity: `runner:${runId}:${attempt}`, migrationHash, schemaHash, observedAt },
});

const evidence = (overrides: Record<string, unknown> = {}) => ({
  candidate: candidate(),
  results: Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success'])),
  dbAfter: { identity: `runner:${runId}:${attempt}`, migrationHash, schemaHash },
  ...overrides,
});

const successfulRun = () => ({
  id: Number(runId),
  run_attempt: attempt,
  repository: { full_name: repository },
  head_branch: 'main',
  head_sha: mainSha,
  path: '.github/workflows/release-candidate.yml',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/${repository}/actions/runs/${runId}`,
});

const requiredRules = () => [
  { type: 'pull_request' },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'Release Candidate Gate' }],
    },
  },
];

type SetupOptions = {
  artifact?: unknown | null;
  run?: ReturnType<typeof successfulRun>;
  existingBranch?: boolean;
  existingPr?: boolean;
  rules?: unknown;
};

function setupOpen({
  artifact = evidence(),
  run = successfulRun(),
  existingBranch = false,
  existingPr = false,
  rules = requiredRules(),
}: SetupOptions = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const writes: Array<{ path: string; method: string; body?: unknown }> = [];
  let branchExists = existingBranch;
  let prExists = existingPr;
  const pullRequest = {
    number: 88,
    state: 'open',
    head: { sha: candidateSha },
    html_url: `https://github.com/${repository}/pull/88`,
  };

  const api = (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === 'user') return { login: 't3-nico' };
    if (path === `repos/${repository}/rules/branches/main`) return rules;
    if (path === `repos/${repository}/actions/runs/${runId}`) return run;
    if (path === `repos/${repository}/git/ref/heads/main`) return { object: { sha: mainSha } };
    if (
      path ===
      `repos/${repository}/git/matching-refs/heads/codex/release-candidate-${runId}-${attempt}`
    ) {
      return branchExists
        ? [
            {
              ref: `refs/heads/codex/release-candidate-${runId}-${attempt}`,
              object: { sha: candidateSha },
            },
          ]
        : [];
    }
    if (path === `repos/${repository}/git/refs` && method === 'POST') {
      branchExists = true;
      return { ref: (body as { ref?: unknown } | undefined)?.ref };
    }
    if (
      path ===
      `repos/${repository}/pulls?state=all&base=main&head=Dayopt%3Acodex%2Frelease-candidate-${runId}-${attempt}`
    ) {
      return prExists ? [pullRequest] : [];
    }
    if (path === `repos/${repository}/pulls` && method === 'POST') {
      prExists = true;
      return pullRequest;
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  };

  const git = (...args: string[]) => {
    if (args[0] === 'fetch' && args[1] === 'origin') return '';
    if (args[0] === 'rev-parse' && args[1] === `${candidateSha}^{tree}`) return candidateTree;
    if (args[0] === 'rev-parse' && args[1] === `${mainSha}^{tree}`) return mainTree;
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return '';
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };

  const download = (_id: string, _name: string, dir: string) => {
    if (artifact !== null)
      writeFileSync(join(dir, 'candidate-evidence.json'), JSON.stringify(artifact));
  };

  return { api, calls, writes, git, download, pullRequest };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('release candidate publisher', () => {
  it('requires strict main checks including the candidate gate before any write', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const fixture = setupOpen({ rules: [{ type: 'pull_request' }] });

    await expect(
      publishCandidate({ mode: 'open', runId, repository, maxAgeSeconds: 3600, ...fixture }),
    ).rejects.toThrow('strict main checks including Release Candidate Gate');
    expect(fixture.writes).toEqual([]);
  });

  it('creates the pinned branch and one draft PR, then reuses both on rerun', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const fixture = setupOpen();

    const first = await publishCandidate({
      mode: 'open',
      runId,
      repository,
      maxAgeSeconds: 3600,
      ...fixture,
    });
    const second = await publishCandidate({
      mode: 'open',
      runId,
      repository,
      maxAgeSeconds: 3600,
      ...fixture,
    });

    expect(first).toEqual(fixture.pullRequest);
    expect(second).toEqual(fixture.pullRequest);
    expect(fixture.writes.filter((call) => call.path.endsWith('/git/refs'))).toHaveLength(1);
    const createdPrs = fixture.writes.filter((call) => call.path.endsWith('/pulls'));
    expect(createdPrs).toHaveLength(1);
    expect(createdPrs[0].body).toMatchObject({
      base: 'main',
      head: `codex/release-candidate-${runId}-${attempt}`,
      draft: true,
    });
  });

  it.each([
    [
      'external repository run',
      { run: { ...successfulRun(), repository: { full_name: 'attacker/fork' } } },
    ],
    ['non-main run', { run: { ...successfulRun(), head_branch: 'integration' } }],
    ['failed run', { run: { ...successfulRun(), conclusion: 'failure' } }],
    ['missing artifact', { artifact: null }],
    [
      'stale artifact',
      {
        artifact: {
          ...evidence(),
          candidate: {
            ...candidate(),
            capturedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          },
        },
      },
    ],
    [
      'artifact from another run',
      { artifact: { ...evidence(), candidate: { ...candidate(), runId: '99999' } } },
    ],
  ])('rejects %s before branch or PR mutation', async (_label, options) => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const fixture = setupOpen(options as Parameters<typeof setupOpen>[0]);

    await expect(
      publishCandidate({ mode: 'open', runId, repository, maxAgeSeconds: 3600, ...fixture }),
    ).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });

  it('requires the trusted main activation environment before querying or writing', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/integration');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const fixture = setupOpen();

    await expect(
      publishCandidate({ mode: 'open', runId, repository, maxAgeSeconds: 3600, ...fixture }),
    ).rejects.toThrow('Candidate activation on trusted main is required');
    expect(fixture.calls).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it('merges through the ordinary API with the exact gated SHA and no bypass', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const gated = { ...candidate(), mainSha };
    const gate = vi.fn(() => gated);
    const api = (path: string, method = 'GET', body?: unknown) => {
      calls.push({ path, method, body });
      if (path === `repos/${repository}/rules/branches/main`) return requiredRules();
      if (path === 'user') return { login: 't3-nico' };
      if (path === `repos/${repository}/pulls/88`)
        return { number: 88, merge_commit_sha: '9'.repeat(40) };
      if (path === `repos/${repository}/commits/${candidateSha}/check-runs?per_page=100`)
        return { check_runs: [] };
      if (path === `repos/${repository}/commits/${candidateSha}/status?per_page=100`)
        return {
          statuses: [
            {
              context: 'Release Candidate Gate',
              state: 'success',
              created_at: now,
            },
          ],
        };
      if (path === `repos/${repository}/pulls/88/merge` && method === 'PUT')
        return { merged: true, sha: '9'.repeat(40) };
      if (path === `repos/${repository}/commits/${'9'.repeat(40)}`) {
        return {
          parents: [{ sha: mainSha }, { sha: candidateSha }],
          commit: { tree: { sha: candidateTree } },
        };
      }
      throw new Error(`Unexpected API call: ${method} ${path}`);
    };

    const result = await publishCandidate({
      mode: 'merge',
      prNumber: '88',
      repository,
      maxAgeSeconds: 3600,
      api,
      gate,
    });

    expect(result).toEqual({ merged: true, sha: '9'.repeat(40) });
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pr', repository, sha: '9'.repeat(40), prNumber: '88' }),
    );
    expect(calls.find((call) => call.path.endsWith('/merge'))).toEqual({
      path: `repos/${repository}/pulls/88/merge`,
      method: 'PUT',
      body: { merge_method: 'merge', sha: candidateSha },
    });
    expect(calls.some((call) => call.path.includes('admin') || call.path.includes('bypass'))).toBe(
      false,
    );
  });

  it('does not call a merge API when the candidate gate rejects the PR', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const writes: string[] = [];
    const api = (path: string, method = 'GET') => {
      if (path === `repos/${repository}/rules/branches/main`) return requiredRules();
      if (path === 'user') return { login: 't3-nico' };
      if (path === `repos/${repository}/pulls/88`)
        return { number: 88, merge_commit_sha: '9'.repeat(40) };
      writes.push(`${method} ${path}`);
      throw new Error(`Unexpected write: ${method} ${path}`);
    };
    const gate = vi.fn(() => {
      throw new Error('Candidate held: gate rejected');
    });

    await expect(
      publishCandidate({
        mode: 'merge',
        prNumber: '88',
        repository,
        maxAgeSeconds: 3600,
        api,
        gate,
      }),
    ).rejects.toThrow('Candidate held: gate rejected');
    expect(writes).toEqual([]);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('rejects the Actions bot identity before merge so normal workflow events can run', async () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('RELEASE_CANDIDATE_ENABLED', 'true');
    const calls: Array<{ path: string; method: string }> = [];
    const writes: string[] = [];
    const api = (path: string, method = 'GET') => {
      calls.push({ path, method });
      if (method !== 'GET') writes.push(`${method} ${path}`);
      if (path === 'user') return { login: 'github-actions[bot]' };
      if (path === `repos/${repository}/rules/branches/main`) return requiredRules();
      if (path === `repos/${repository}/pulls/88`)
        return { number: 88, merge_commit_sha: '9'.repeat(40) };
      throw new Error(`Unexpected API call: GET ${path}`);
    };
    const gate = vi.fn(() => candidate());

    await expect(
      publishCandidate({
        mode: 'merge',
        prNumber: '88',
        repository,
        maxAgeSeconds: 3600,
        api,
        gate,
      }),
    ).rejects.toThrow();

    expect(calls.map((call) => call.path)).toContain('user');
    expect(writes).toEqual([]);
    expect(calls.some((call) => call.path.endsWith('/merge'))).toBe(false);
  });
});
