import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCandidateGate } from './release-candidate-gate.mjs';

const repository = 'Dayopt/dayopt';
const mainSha = 'c'.repeat(40);
const candidateSha = 'a'.repeat(40);
const candidateTree = 'b'.repeat(40);
const mainTree = 'd'.repeat(40);
const mergeSha = '9'.repeat(40);
const runId = '12345';
const attempt = '2';
const prNumber = '678';
const now = Date.now();
const capturedAt = new Date(now - 60_000).toISOString();
const db = {
  identity: `runner:container:${runId}:${attempt}`,
  migrationHash: 'e'.repeat(64),
  schemaHash: 'f'.repeat(64),
  observedAt: new Date(now - 30_000).toISOString(),
};

type CandidateEvidence = {
  candidate: {
    version: number;
    sha: string;
    tree: string;
    mainSha: string;
    mainTree: string;
    runId: string;
    attempt: string;
    capturedAt: string;
    db: typeof db;
  };
  results: Record<string, string>;
  dbAfter: typeof db;
};

type GateOptions = {
  head?: { ref?: string; sha?: string; repo?: { full_name: string } };
  base?: { ref?: string; sha?: string; repo?: { full_name: string } };
  pr?: { body?: string; state?: string; merged?: boolean; draft?: boolean };
  run?: { run_attempt?: number; status?: string; conclusion?: string };
  evidence?: Partial<CandidateEvidence>;
  evidenceTransform?: (evidence: CandidateEvidence) => CandidateEvidence;
  missingArtifact?: boolean;
  releaseSha?: string;
  currentMainSha?: string;
  commit?: { parents?: Array<{ sha: string }>; commit?: { tree: { sha: string } } };
  prMergeCommit?: { parents?: Array<{ sha: string }>; commit?: { tree: { sha: string } } };
  candidateGitTree?: string;
  maxAgeSeconds?: number;
};

function fixture(mode: 'pr' | 'production' = 'pr', options: GateOptions = {}) {
  const head = {
    ref: `codex/release-candidate-${runId}-${attempt}`,
    sha: candidateSha,
    repo: { full_name: repository },
    ...options.head,
  };
  const base = {
    ref: 'main',
    sha: mainSha,
    repo: { full_name: repository },
    ...options.base,
  };
  const pr = {
    number: Number(prNumber),
    body: `Promotion candidate\n\n<!-- release-candidate:${runId}:${attempt} -->`,
    state: mode === 'pr' ? 'open' : 'closed',
    merged: mode === 'production',
    draft: false,
    head,
    base,
    ...options.pr,
  };
  const run = {
    id: Number(runId),
    run_attempt: Number(attempt),
    repository: { full_name: repository },
    path: '.github/workflows/release-candidate.yml',
    head_branch: 'main',
    head_sha: mainSha,
    status: 'completed',
    conclusion: 'success',
    ...options.run,
  };
  const evidence = {
    candidate: {
      version: 1,
      sha: candidateSha,
      tree: candidateTree,
      mainSha,
      mainTree,
      runId,
      attempt,
      capturedAt,
      db,
    },
    results: {
      unit: 'success',
      integration: 'success',
      db_upgrade: 'success',
      e2e: 'success',
      web: 'success',
      storybook: 'success',
    },
    dbAfter: db,
    ...options.evidence,
  };

  const releaseSha = options.releaseSha ?? mergeSha;
  const currentMainSha = options.currentMainSha ?? (mode === 'production' ? releaseSha : mainSha);
  const productionCommit = {
    parents: [{ sha: mainSha }, { sha: candidateSha }],
    commit: { tree: { sha: candidateTree } },
    ...options.commit,
  };
  const prMergeCommit = {
    parents: [{ sha: mainSha }, { sha: head.sha }],
    commit: { tree: { sha: candidateTree } },
    ...options.prMergeCommit,
  };
  const apiCalls: string[] = [];
  const api = (path: string) => {
    apiCalls.push(path);
    if (path === `repos/${repository}/git/ref/heads/main`)
      return { object: { sha: currentMainSha } };
    if (path === `repos/${repository}/pulls/${prNumber}`) return pr;
    if (path === `repos/${repository}/commits/${mode === 'production' ? releaseSha : mergeSha}`)
      return mode === 'production' ? productionCommit : prMergeCommit;
    if (path === `repos/${repository}/commits/${releaseSha}/pulls`)
      return [
        {
          number: Number(prNumber),
          merged_at: '2026-10-05T01:00:00Z',
          merge_commit_sha: releaseSha,
          base: { ref: 'main' },
        },
      ];
    if (path.startsWith(`repos/${repository}/actions/runs/`)) {
      return { ...run, id: Number(path.split('/').at(-1)) };
    }
    throw new Error(`Unexpected API request: ${path}`);
  };
  const gitCalls: string[][] = [];
  const git = (...args: string[]) => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse' && args[1] === `${candidateSha}^{tree}`)
      return options.candidateGitTree ?? candidateTree;
    if (args[0] === 'rev-parse' && args[1] === `${mainSha}^{tree}`) return mainTree;
    return '';
  };
  const downloadCalls: Array<{ runId: string; name: string }> = [];
  const download = (id: string, name: string, dir: string) => {
    downloadCalls.push({ runId: id, name });
    if (!options.missingArtifact) {
      const artifact = options.evidenceTransform
        ? options.evidenceTransform(evidence)
        : { ...evidence, ...options.evidence };
      writeFileSync(join(dir, 'candidate-evidence.json'), JSON.stringify(artifact));
    }
  };

  return {
    apiCalls,
    gitCalls,
    downloadCalls,
    runGate: () =>
      runCandidateGate({
        mode,
        repository,
        sha: mode === 'production' ? releaseSha : mergeSha,
        prNumber,
        maxAgeSeconds: options.maxAgeSeconds ?? 3600,
        api,
        git,
        download,
      } as Parameters<typeof runCandidateGate>[0]),
  };
}

describe('release candidate promotion gate', () => {
  it('accepts a PR only when its synthetic merge is the tested tree', () => {
    const state = fixture('pr');

    expect(state.runGate()).toMatchObject({ sha: candidateSha, tree: candidateTree });
    expect(state.downloadCalls).toEqual([{ runId, name: `candidate-evidence-${attempt}` }]);
    expect(state.gitCalls).toContainEqual(['merge-base', '--is-ancestor', mainSha, candidateSha]);
  });

  it('accepts Production only for the two-parent merge of the verified candidate PR', () => {
    const state = fixture('production');

    expect(state.runGate()).toMatchObject({ sha: candidateSha, tree: candidateTree });
    expect(state.apiCalls).toContain(`repos/${repository}/commits/${mergeSha}/pulls`);
  });

  it.each([
    '',
    'untrusted prose',
    `<!-- release-candidate:${runId}:${attempt} -->\n<!-- release-candidate:${runId}:3 -->`,
  ])('rejects a missing or ambiguous PR reference: %s', (body) => {
    const state = fixture('pr', { pr: { body } });
    expect(() => state.runGate()).toThrow(/exactly one candidate reference/);
  });

  it.each([
    ['external repository', { head: { repo: { full_name: 'someone/fork' } } }],
    ['wrong branch', { head: { ref: 'integration' } }],
    ['wrong head SHA', { head: { sha: '7'.repeat(40) } }],
    ['wrong base branch', { base: { ref: 'integration' } }],
    ['external base repository', { base: { repo: { full_name: 'someone/fork' } } }],
    ['changed main base', { base: { sha: '8'.repeat(40) } }],
    ['draft PR', { pr: { draft: true } }],
  ])('holds the PR gate for %s', (_label, changes) => {
    const state = fixture('pr', changes);
    expect(() => state.runGate()).toThrow(/promotion PR identity\/base\/head differs/);
  });

  it('rejects a forged PR marker that points at another candidate run', () => {
    const state = fixture('pr', {
      pr: { body: 'Promotion candidate\n\n<!-- release-candidate:99999:2 -->' },
    });
    expect(() => state.runGate()).toThrow(/artifact belongs to another attempt/);
  });

  it('holds when main receives a hotfix before the candidate PR merge', () => {
    const state = fixture('pr', { currentMainSha: '8'.repeat(40) });
    expect(() => state.runGate()).toThrow(/synthetic merge is stale/);
  });

  it('holds when main advances after the promotion merge but before Production starts', () => {
    const state = fixture('production', { currentMainSha: '8'.repeat(40) });
    expect(() => state.runGate()).toThrow(/main advanced before Production/);
  });

  it('requires the production merge commit to have exactly two parents', () => {
    const state = fixture('production', { commit: { parents: [{ sha: mainSha }] } });
    expect(() => state.runGate()).toThrow(/two-parent merge commit/);
  });

  it('requires the second merge parent to be the promotion PR head', () => {
    const state = fixture('production', {
      commit: { parents: [{ sha: mainSha }, { sha: '7'.repeat(40) }] },
    });
    expect(() => state.runGate()).toThrow(/merge parent differs from candidate/);
  });

  it('rejects stale candidate evidence', () => {
    const stale = new Date(now - 3_600_001).toISOString();
    const state = fixture('pr', {
      evidenceTransform: (evidence) => ({
        ...evidence,
        candidate: {
          ...evidence.candidate,
          capturedAt: stale,
          db: { ...evidence.candidate.db, observedAt: new Date(now - 3_599_000).toISOString() },
        },
      }),
    });
    expect(() => state.runGate()).toThrow(/stale or from the future/);
  });

  it('rejects an artifact from a previous workflow attempt', () => {
    const state = fixture('pr', { run: { run_attempt: 1 } });
    expect(() => state.runGate()).toThrow(/trusted successful latest attempt/);
  });

  it.each([
    ['running', { status: 'in_progress', conclusion: 'success' }],
    ['failed', { status: 'completed', conclusion: 'failure' }],
  ])('rejects a %s workflow run', (_label, run) => {
    const state = fixture('pr', { run });
    expect(() => state.runGate()).toThrow(/trusted successful latest attempt/);
  });

  it('fails closed when the referenced artifact is missing', () => {
    const state = fixture('pr', { missingArtifact: true });
    expect(() => state.runGate()).toThrow();
  });

  it('rejects candidate SHA evidence that differs from the promotion PR head', () => {
    const state = fixture('pr', {
      evidenceTransform: (evidence) => ({
        ...evidence,
        candidate: { ...evidence.candidate, sha: '7'.repeat(40) },
      }),
    });
    expect(() => state.runGate()).toThrow(/promotion PR identity\/base\/head differs/);
  });

  it('rejects candidate tree evidence that differs from the repository tree', () => {
    const state = fixture('pr', {
      evidenceTransform: (evidence) => ({
        ...evidence,
        candidate: { ...evidence.candidate, tree: '7'.repeat(40) },
      }),
    });
    expect(() => state.runGate()).toThrow(/repository trees differ/);
  });

  it('rejects a synthetic merge whose content differs from the candidate tree', () => {
    const state = fixture('pr', { prMergeCommit: { commit: { tree: { sha: '7'.repeat(40) } } } });
    expect(() => state.runGate()).toThrow(/tested and promotion trees differ/);
  });
});
