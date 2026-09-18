import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildTrustedPlan,
  collectEvidence,
  collectInheritedPreviews,
  createGithubApi,
  fetchAllReviewPages,
  isUnsafeStatusDescriptionChar,
  resolveTarget,
  runValidationGate,
  STATUS_DESCRIPTION_FALLBACK,
  toStatusDescription,
} from './validation-gate.mjs';

const REPO = 'Dayopt/dayopt';
const CI = '.github/workflows/ci.yml';

// ── git fixture: main（信頼済み）と candidate（PR）、refs/validation/pull/7/merge ──
const cwd = mkdtempSync(join(tmpdir(), 'validation-gate-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git('init', '-b', 'main');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'user.name', 'Fixture');
mkdirSync(join(cwd, 'scripts/lib'), { recursive: true });
mkdirSync(join(cwd, 'apps/product/src'), { recursive: true });
writeFileSync(join(cwd, 'README.md'), 'hello\n');
writeFileSync(join(cwd, 'scripts/lib/validation-plan.mjs'), '// base policy\n');
git('add', '-A');
git('commit', '-m', 'baseline');
const baseSha = git('rev-parse', 'HEAD');

git('checkout', '-b', 'candidate');
writeFileSync(join(cwd, 'apps/product/src/a.ts'), 'export const a = 1;\n');
// PR 側が policy を書き換えても、plan は base の policy から生成される（自己免除不可）
writeFileSync(
  join(cwd, 'scripts/lib/validation-plan.mjs'),
  'throw new Error("candidate policy");\n',
);
git('add', '-A');
git('commit', '-m', 'candidate change');
const headSha = git('rev-parse', 'HEAD');
git('checkout', 'main');
git('update-ref', 'refs/validation/pull/7/head', headSha);
// main が進んだ後の状態（PR は behind）。README だけ変える → merge 可能
writeFileSync(join(cwd, 'README.md'), 'hello again\n');
git('add', '-A');
git('commit', '-m', 'main moved');
const movedMain = git('rev-parse', 'HEAD');
// candidate と同じ path を別内容で足す → conflict
git('checkout', '-b', 'conflicting', baseSha);
mkdirSync(join(cwd, 'apps/product/src'), { recursive: true });
writeFileSync(join(cwd, 'apps/product/src/a.ts'), 'export const a = 2;\n');
git('add', '-A');
git('commit', '-m', 'conflicting main');
const conflictingMain = git('rev-parse', 'HEAD');
git('checkout', 'main');
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

// ── GitHub API fixture（実 PR #2800 の応答形を縮約）────────────────────
const run = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  path: CI,
  event: 'pull_request',
  head_sha: headSha,
  repository: { full_name: REPO },
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  ...patch,
});
const jobs = (conclusions: Record<string, string>) => ({
  jobs: Object.entries(conclusions).map(([name, conclusion], index) => ({
    id: index,
    name,
    status: 'completed',
    conclusion,
    run_attempt: 1,
    html_url: `https://github.com/${REPO}/actions/runs/100/job/${index}`,
  })),
});
const pull = (patch: Record<string, unknown> = {}) => ({
  number: 7,
  state: 'open',
  draft: false,
  head: { sha: headSha, repo: { full_name: REPO } },
  base: { ref: 'main', sha: baseSha, repo: { full_name: REPO } },
  ...patch,
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [pull()],
    [`repos/${REPO}/pulls/7`]: pull(),
    [`repos/${REPO}/actions/runs?head_sha=${headSha}&per_page=100`]: [
      { workflow_runs: [run(100), run(50, { path: '.github/workflows/validation-shadow.yml' })] },
    ],
    [`repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`]: [
      jobs({
        '🧭 Impact': 'success',
        '🔍 Static Checks': 'success',
        '📦 Unit Tests': 'success',
        '🧪 Integration Tests': 'skipped',
      }),
    ],
    [`repos/${REPO}/actions/runs/50/jobs?filter=latest&per_page=100`]: [
      jobs({ 'Validation plan (shadow)': 'success' }),
    ],
    [`repos/${REPO}/commits/${headSha}/status`]: {
      statuses: [
        {
          context: 'Vercel – product',
          state: 'success',
          target_url: 'https://vercel.com/dayopt/product/x',
          description: 'Deployment has completed',
        },
      ],
    },
    [`repos/${REPO}/deployments?sha=${headSha}&per_page=100`]: [
      {
        id: 6480165896,
        sha: headSha,
        environment: 'Preview – product',
        production_environment: false,
        created_at: '2026-09-16T11:51:09Z',
      },
    ],
    [`repos/${REPO}/deployments/6480165896/statuses?per_page=100`]: [
      { id: 1, state: 'pending', environment_url: null },
      { id: 2, state: 'success', environment_url: 'https://product-x.vercel.app' },
    ],
    [`repos/${REPO}/compare/main...${headSha}`]: { status: 'ahead' },
    [`repos/${REPO}/commits/${headSha}/check-runs?per_page=100`]: [
      {
        check_runs: [
          {
            id: 104781444130,
            name: 'Supabase Preview',
            app: { slug: 'supabase' },
            head_sha: headSha,
            status: 'completed',
            conclusion: 'skipped',
            html_url: `https://github.com/${REPO}/runs/104781444130`,
          },
          {
            id: 1,
            name: '🔍 Static Checks',
            app: { slug: 'github-actions' },
            head_sha: headSha,
            status: 'completed',
            conclusion: 'success',
            html_url: '',
          },
        ],
      },
    ],
    [`repos/${REPO}/pulls/7/reviews?per_page=100`]: [
      {
        id: 5221740744,
        user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
        state: 'COMMENTED',
        commit_id: headSha,
        submitted_at: '2026-09-16T10:56:22Z',
        html_url: `https://github.com/${REPO}/pull/7#pullrequestreview-5221740744`,
        body: `**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
      },
    ],
    [`repos/${REPO}/issues/7/comments?per_page=100`]: [
      {
        id: 1,
        user: { login: 't3-nico', type: 'User' },
        author_association: 'OWNER',
        body: '@codex review',
        created_at: '2026-09-16T10:48:06Z',
        html_url: `https://github.com/${REPO}/pull/7#issuecomment-1`,
      },
      {
        id: 2,
        user: { login: 't3-nico', type: 'User' },
        author_association: 'OWNER',
        body: `[review-summary]\nhead: ${headSha}\nprovider: codex\nagent: risk-reviewer\nstatus: reviewed\nfindings: 0\n`,
        created_at: '2026-09-16T10:58:00Z',
        html_url: `https://github.com/${REPO}/pull/7#issuecomment-2`,
      },
    ],
    [`repos/${REPO}/commits/${headSha}`]: {
      commit: { committer: { date: '2026-09-16T10:50:00Z' } },
    },
    ...overrides,
  };
  const calls: string[] = [];
  const api = (path: string) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`unexpected API call: ${path}`);
    return structuredClone(routes[path]);
  };
  return { api, calls };
}

function fakeGraphql(threads: unknown[] = []) {
  return () => ({
    repository: {
      pullRequest: {
        reviews: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: 'PRR_1', databaseId: 5221740744 }],
        },
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: threads.length
            ? threads
            : [
                {
                  id: 'PRRT_1',
                  isResolved: true,
                  isOutdated: false,
                  path: 'apps/product/src/a.ts',
                  comments: {
                    nodes: [
                      {
                        author: { login: 'chatgpt-codex-connector' },
                        body: 'P2',
                        pullRequestReview: { id: 'PRR_1' },
                      },
                      {
                        author: { login: 't3-nico', __typename: 'User' },
                        authorAssociation: 'OWNER',
                        body: '対応済み',
                        pullRequestReview: { id: 'PRR_2' },
                      },
                    ],
                  },
                },
              ],
        },
      },
    },
  });
}

const env = (patch: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: REPO,
  GITHUB_SHA: baseSha,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  ...patch,
});

describe('validation gate controller', () => {
  it('regenerates the plan from the trusted base policy and never runs candidate code', () => {
    const plan = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: baseSha,
      cwd,
      fetchImpl: () => {},
    });
    expect(plan.status).toBe('determinate');
    expect(plan.identity.policySha).toBe(baseSha);
    expect(plan.identity.baseSha).toBe(baseSha);
    expect(git('show', '-s', '--format=%P', plan.identity.testSha).split(' ')).toEqual([
      baseSha,
      headSha,
    ]);
    expect(plan.files).toEqual(['apps/product/src/a.ts', 'scripts/lib/validation-plan.mjs']);
    expect(plan.review.status).toBe('required');
  });

  it('builds the test merge against the current main even when the PR is behind', () => {
    const plan = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: movedMain,
      cwd,
      fetchImpl: () => {},
    });
    expect(plan.status).toBe('determinate');
    expect(plan.identity.baseSha).toBe(movedMain);
    expect(plan.files).toEqual(['apps/product/src/a.ts', 'scripts/lib/validation-plan.mjs']);
  });

  it('is indeterminate when the PR conflicts with the base', () => {
    const plan = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: conflictingMain,
      cwd,
      fetchImpl: () => {},
    });
    expect(plan.status).toBe('indeterminate');
    expect(plan.problems).toContain('test merge unavailable (merge conflict with base)');
  });

  it('is indeterminate when the fetched head differs from the PR head', () => {
    const plan = buildTrustedPlan({
      repository: REPO,
      pr: pull({ head: { sha: baseSha, repo: { full_name: REPO } } }),
      policySha: baseSha,
      cwd,
      fetchImpl: () => {},
    });
    expect(plan.status).toBe('indeterminate');
    expect(plan.problems).toContain('PR head unavailable (fetched head does not match PR head)');
  });

  it('builds the same test merge SHA on repeated evaluation (deterministic plan id)', () => {
    const first = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: baseSha,
      cwd,
      fetchImpl: () => {},
    });
    const second = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: baseSha,
      cwd,
      fetchImpl: () => {},
    });
    expect(second.identity.testSha).toBe(first.identity.testSha);
    expect(second.planId).toBe(first.planId);
  });

  it('produces an indeterminate plan when the PR head cannot be fetched', () => {
    const plan = buildTrustedPlan({
      repository: REPO,
      pr: pull(),
      policySha: baseSha,
      cwd,
      fetchImpl: () => {
        throw new Error('conflict');
      },
    });
    expect(plan.status).toBe('indeterminate');
    expect(plan.problems).toContain('PR head unavailable (conflict)');
  });

  it('normalizes GitHub responses into evidence without API field names', () => {
    const { api } = fakeApi();
    const evidence = collectEvidence({
      repository: REPO,
      pr: pull(),
      api,
      now: () => new Date('2026-09-17T00:00:00Z'),
    });
    expect(evidence.workflowRuns.map((r: { id: number }) => r.id)).toEqual([100, 50]);
    expect(evidence.workflowRuns[0].jobs.map((j: { name: string }) => j.name)).toContain(
      '🧪 Integration Tests',
    );
    expect(evidence.deployments[0]).toMatchObject({
      id: 6480165896,
      latestStatus: { state: 'success', environmentUrl: 'https://product-x.vercel.app' },
    });
    expect(evidence.baseCompare).toBe('ahead');
    expect(evidence.pr.fork).toBe(false);
    // Actions の job は workflowRuns 側で見るので check run からは除く
    expect(evidence.checkRuns.map((run: { name: string }) => run.name)).toEqual([
      'Supabase Preview',
    ]);
  });

  it('resolves the target PR from the workflow_run head sha and ignores closed or stacked PRs', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [
        pull({ number: 9, state: 'closed' }),
        // stacked PR: この commit を祖先に含むが head は別（先頭に来ても選ばない）
        pull({ number: 8, head: { sha: 'f'.repeat(40), repo: { full_name: REPO } } }),
        pull(),
      ],
    });
    expect(
      resolveTarget({
        eventName: 'workflow_run',
        event: { workflow_run: { head_sha: headSha } },
        prArg: undefined,
        repository: REPO,
        api,
      }),
    ).toEqual({ number: 7, source: 'workflow_run', eventSha: headSha });
    // Supabase Preview の check run 完了（default branch の定義で走る event）も head から PR を引く
    expect(
      resolveTarget({
        eventName: 'check_run',
        event: { check_run: { head_sha: headSha, app: { slug: 'supabase' } } },
        prArg: undefined,
        repository: REPO,
        api,
      }),
    ).toEqual({ number: 7, source: 'check_run', eventSha: headSha });
    expect(
      resolveTarget({
        eventName: 'workflow_run',
        event: {},
        prArg: undefined,
        repository: REPO,
        api,
      }),
    ).toBeNull();
    expect(
      resolveTarget({
        eventName: 'workflow_dispatch',
        event: {},
        prArg: '0',
        repository: REPO,
        api,
      }),
    ).toBeNull();
  });

  it('evaluates an open PR end to end and publishes a non-required status', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    const resultPath = join(cwd, 'result.json');
    const outcome = runValidationGate({
      env: env({
        VALIDATION_RESULT_PATH: resultPath,
        GITHUB_RUN_ID: '1',
        GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.skipped).toBeNull();
    expect(outcome.result?.verdict).toBe('pass');
    expect(outcome.result?.suites.integration.status).toBe('not-applicable');
    expect(outcome.result?.suites.productPreview.status).toBe('satisfied');
    expect(outcome.review?.verdict).toBe('satisfied');
    expect(outcome.review?.evidence?.adjudication).toEqual({
      findings: 1,
      unresolved: 0,
      silent: 0,
    });
    expect(posted).toHaveLength(4); // pending ×2 → final ×2
    expect(posted[0]).toContain('state=pending');
    expect(posted[2]).toContain(`repos/${REPO}/statuses/${headSha}`);
    expect(posted[2]).toContain('state=success');
    expect(posted[2]).toContain('context=Validation (shadow)');
    expect(posted[3]).toContain('context=Review policy (shadow)');
    expect(posted[3]).toContain('state=success');
    const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(saved.plan.identity.policySha).toBe(baseSha);
    expect(saved.result.verdict).toBe('pass');
    expect(saved.review.state).toBe('complete');
  });

  it('does not publish a status for a local --pr run (only workflow_run publishes)', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env(),
      argv: ['--pr', '7'],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.result?.verdict).toBe('pass');
    expect(posted).toHaveLength(0);
  });

  it('blocks when the PR removed a required job from ci.yml (no self-exemption)', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`]: [
        jobs({ '🧭 Impact': 'success', '🔍 Static Checks': 'success' }),
      ],
    });
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.result?.verdict).toBe('blocked');
    expect(outcome.result?.suites.productUnit.status).toBe('missing');
    expect(posted.at(-2)).toContain('state=failure');
    expect(outcome.review?.trigger.shouldRequest).toBe(false);
  });

  it('skips a stale event whose head moved on instead of publishing for it', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/pulls/7`]: pull({ head: { sha: 'f'.repeat(40), repo: { full_name: REPO } } }),
    });
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {
        throw new Error('not fetched in test');
      },
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.skipped).toMatch(/superseded/);
    expect(outcome.result).toBeNull();
    expect(posted).toHaveLength(0);
  });

  it('refuses to evaluate or publish from a non-default ref (PR-side workflow definition)', () => {
    const { api, calls } = fakeApi();
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({ GITHUB_REF: 'refs/heads/claude/some-pr-branch' }),
      argv: ['--pr', '7'],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.skipped).toMatch(/untrusted ref/);
    expect(calls).toEqual([]);
    expect(posted).toHaveLength(0);
  });

  it('waits for a pending Preview within the budget and re-evaluates', () => {
    let statusCalls = 0;
    const { api } = fakeApi({
      [`repos/${REPO}/deployments/6480165896/statuses?per_page=100`]: [],
    });
    const flaky = (path: string) => {
      if (path === `repos/${REPO}/deployments/6480165896/statuses?per_page=100`) {
        statusCalls += 1;
        return statusCalls < 3
          ? [{ id: 1, state: 'pending', environment_url: null }]
          : [{ id: 2, state: 'success', environment_url: 'https://product-x.vercel.app' }];
      }
      return api(path);
    };
    let clock = Date.parse('2026-09-17T00:00:00Z');
    const slept: number[] = [];
    const outcome = runValidationGate({
      env: env({ VALIDATION_WAIT_MINUTES: '10', GITHUB_REF: 'refs/heads/main' }),
      argv: ['--pr', '7'],
      api: flaky,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: () => '',
      now: () => new Date(clock),
      pollIntervalMs: 30_000,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    expect(slept).toEqual([30_000, 30_000]);
    expect(outcome.result?.verdict).toBe('pass');
  });

  it('stops waiting at the budget and publishes pending', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/deployments/6480165896/statuses?per_page=100`]: [
        { id: 1, state: 'pending', environment_url: null },
      ],
    });
    let clock = Date.parse('2026-09-17T00:00:00Z');
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({ VALIDATION_WAIT_MINUTES: '1' }),
      argv: ['--pr', '7'],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
      now: () => new Date(clock),
      pollIntervalMs: 30_000,
      sleep: (ms) => {
        clock += ms;
      },
    });
    expect(outcome.result?.verdict).toBe('pending');
    expect(posted).toHaveLength(0); // --pr（ローカル）では発行しない
  });

  it('publishes pending first and failure when evidence collection throws (fail closed)', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    expect(() =>
      runValidationGate({
        env: env({
          GITHUB_EVENT_NAME: 'workflow_run',
          GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
        }),
        argv: [],
        api: (path: string) => {
          if (path.includes('/actions/runs?')) throw new Error('HTTP 502');
          return api(path);
        },
        graphql: fakeGraphql(),
        cwd,
        fetchImpl: () => {},
        output: () => {},
        postStatus: (args) => {
          posted.push(args);
          return '';
        },
      }),
    ).toThrow('HTTP 502');
    expect(posted.map((args) => args.find((arg) => arg.startsWith('state=')))).toEqual([
      'state=pending',
      'state=pending',
      'state=failure',
      'state=failure',
    ]);
    expect(posted[2].join(' ')).toContain('indeterminate: HTTP 502');
  });

  it('still tries to publish failure when even the initial pending post fails', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    expect(() =>
      runValidationGate({
        env: env({
          GITHUB_EVENT_NAME: 'workflow_run',
          GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
        }),
        argv: [],
        api,
        cwd,
        fetchImpl: () => {},
        output: () => {},
        postStatus: (args) => {
          posted.push(args);
          if (posted.length === 1) throw new Error('HTTP 502 on pending');
          return '';
        },
      }),
    ).toThrow('HTTP 502 on pending');
    // 最初の pending（Validation）で落ちても、両 context へ failure を発行する
    expect(posted.map((args) => args.find((arg) => arg.startsWith('state=')))).toEqual([
      'state=pending',
      'state=failure',
      'state=failure',
    ]);
  });

  it('publishes failure to the event SHA when PR resolution itself fails', () => {
    const posted: string[][] = [];
    expect(() =>
      runValidationGate({
        env: env({
          GITHUB_EVENT_NAME: 'workflow_run',
          GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
        }),
        argv: [],
        api: () => {
          throw new Error('HTTP 502 on pulls');
        },
        cwd,
        fetchImpl: () => {},
        output: () => {},
        postStatus: (args) => {
          posted.push(args);
          return '';
        },
      }),
    ).toThrow('HTTP 502 on pulls');
    expect(posted).toHaveLength(2); // Validation / Review policy の両 context へ failure
    for (const args of posted) {
      expect(args).toContain(`repos/${REPO}/statuses/${headSha}`);
      expect(args).toContain('state=failure');
    }
  });

  it('publishes nothing for a trusted event without an open PR (main commits)', () => {
    const { api } = fakeApi({ [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [] });
    const posted: string[][] = [];
    runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'status',
        GITHUB_EVENT_PATH: writeEvent({
          sha: headSha,
          context: 'Vercel – product',
          state: 'success',
        }),
      }),
      argv: [],
      api,
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(posted).toHaveLength(0);
  });

  it('re-evaluates from a Vercel status event and publishes', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'status',
        GITHUB_EVENT_PATH: writeEvent({
          sha: headSha,
          context: 'Vercel – product',
          state: 'success',
        }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.result?.verdict).toBe('pass');
    expect(posted.at(-2)).toContain('state=success');
  });

  it('skips events that are not associated with an open PR', () => {
    const { api } = fakeApi({ [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [] });
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: writeEvent({ workflow_run: { head_sha: headSha } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: () => '',
    });
    expect(outcome.skipped).toBe('no open PR for this event');
  });

  it('normalizes review evidence and never posts a review request in shadow', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/pulls/7/reviews?per_page=100`]: [],
      // [review-summary] が無い状態（代替レビュー無し）で、依頼は head より前 → not-started
      [`repos/${REPO}/issues/7/comments?per_page=100`]: [
        {
          id: 1,
          user: { login: 't3-nico', type: 'User' },
          author_association: 'OWNER',
          body: '@codex review',
          created_at: '2026-09-16T10:48:06Z',
          html_url: `https://github.com/${REPO}/pull/7#issuecomment-1`,
        },
      ],
    });
    const outputs: string[] = [];
    const outcome = runValidationGate({
      env: env(),
      argv: ['--pr', '7'],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: (text) => {
        outputs.push(text);
      },
      postStatus: () => '',
      now: () => new Date('2026-09-16T10:55:00Z'),
    });
    // 依頼 comment は head より前 → 無視され、not-started で「起動する」判定になるが投稿はしない
    expect(outcome.review?.state).toBe('not-started');
    expect(outcome.review?.trigger.shouldRequest).toBe(true);
    expect(outputs.some((text) => text.startsWith('::notice::Review policy'))).toBe(true);
  });

  it('reads every reviewThreads page and fails closed on an incomplete page', () => {
    const calls: Record<string, unknown>[] = [];
    const page = (hasNextPage: boolean, id: string) => ({
      repository: {
        pullRequest: {
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? `c-${id}` : null },
            nodes: [
              { id, isResolved: true, isOutdated: false, path: null, comments: { nodes: [] } },
            ],
          },
        },
      },
    });
    const graphql = (_query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      return variables.threadsAfter === 'c-T1' ? page(false, 'T2') : page(true, 'T1');
    };
    const pages = fetchAllReviewPages({ graphql, owner: 'Dayopt', name: 'dayopt', number: 7 });
    expect(pages.threads.map((thread: { id: string }) => thread.id)).toEqual(['T1', 'T2']);
    expect(calls[1].threadsAfter).toBe('c-T1');
    expect(() =>
      fetchAllReviewPages({
        graphql: () => ({
          repository: { pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: [] } } },
        }),
        owner: 'Dayopt',
        name: 'dayopt',
        number: 7,
      }),
    ).toThrow('incomplete');
  });

  it('resolves the PR from an issue_comment event and publishes to the PR head', () => {
    const { api } = fakeApi();
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: writeEvent({ issue: { number: 7, pull_request: { url: 'x' } } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.result?.verdict).toBe('pass');
    expect(posted.at(-1)).toContain(`repos/${REPO}/statuses/${headSha}`);
    expect(
      resolveTarget({
        eventName: 'issue_comment',
        event: { issue: { number: 3 } },
        prArg: undefined,
        repository: REPO,
        api,
      }),
    ).toBeNull();
  });

  it('does not publish for a PR whose base is not main (stacked PR sharing the head)', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/pulls/7`]: pull({
        base: { ref: 'feature/x', sha: baseSha, repo: { full_name: REPO } },
      }),
    });
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: writeEvent({ issue: { number: 7, pull_request: { url: 'x' } } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.skipped).toMatch(/does not target/);
    expect(posted).toHaveLength(0);
  });

  it('does not evaluate or publish for a closed PR reached through issue_comment', () => {
    const { api } = fakeApi({ [`repos/${REPO}/pulls/7`]: pull({ state: 'closed' }) });
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: writeEvent({ issue: { number: 7, pull_request: { url: 'x' } } }),
      }),
      argv: [],
      api,
      graphql: fakeGraphql(),
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: (args) => {
        posted.push(args);
        return '';
      },
    });
    expect(outcome.skipped).toMatch(/closed/);
    expect(posted).toHaveLength(0);
  });

  it('flattens paginated gh api output and passes exact argv (no shell)', () => {
    const seen: string[][] = [];
    const api = createGithubApi({
      execFileImpl: (_file: string, args: string[]) => {
        seen.push(args);
        return args.includes('--paginate') ? '[[{"id":1}],[{"id":2}]]' : '{"ok":true}';
      },
    });
    expect(api('repos/x/y/deployments', { paginate: true })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(api('repos/x/y/pulls/1')).toEqual({ ok: true });
    expect(seen[0]).toEqual(['api', '--paginate', '--slurp', 'repos/x/y/deployments']);
  });
});

function writeEvent(payload: unknown) {
  const path = join(cwd, `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe('ancestor Preview evidence (#2807)', () => {
  const previewPr = () =>
    pull({ commits: 2, head: { sha: headSha, ref: 'candidate', repo: { full_name: REPO } } });
  const routes = () => ({
    [`repos/${REPO}/pulls/7/commits?per_page=100`]: [{ sha: baseSha }, { sha: headSha }],
    [`repos/${REPO}/deployments?sha=${baseSha}&per_page=100`]: [
      {
        id: 987,
        sha: baseSha,
        ref: 'candidate',
        environment: 'Preview – web',
        production_environment: false,
      },
    ],
    [`repos/${REPO}/commits/${baseSha}/pulls?per_page=100`]: [previewPr()],
    [`repos/${REPO}/deployments/987/statuses?per_page=100`]: [
      { id: 1, state: 'success', environment_url: 'https://preview.invalid' },
    ],
  });
  const collect = (overrides: Record<string, unknown> = {}, pr = previewPr()) =>
    collectInheritedPreviews({
      repository: REPO,
      pr,
      api: fakeApi({ ...routes(), ...overrides }).api,
      cwd,
      statuses: [
        {
          context: 'Vercel – web',
          state: 'success',
          description: 'Canceled by Ignored Build Step',
        },
      ],
    });
  it('accepts an ancestor only for the unchanged app (product changed, web unchanged)', () => {
    expect(collect()).toEqual([
      expect.objectContaining({
        ancestorSha: baseSha,
        deploymentId: 987,
        environment: 'Preview – web',
        unchanged: true,
      }),
    ]);
  });
  it.each([
    ['missing commits', { [`repos/${REPO}/pulls/7/commits?per_page=100`]: [] }],
    [
      'another PR',
      { [`repos/${REPO}/commits/${baseSha}/pulls?per_page=100`]: [pull({ number: 8 })] },
    ],
    [
      'failed deployment',
      { [`repos/${REPO}/deployments/987/statuses?per_page=100`]: [{ id: 2, state: 'failure' }] },
    ],
    ['no deployment', { [`repos/${REPO}/deployments?sha=${baseSha}&per_page=100`]: [] }],
  ])('rejects %s', (_name, overrides) => {
    expect(collect(overrides)).toEqual([]);
  });
  it.each([
    { ref: 'other' },
    { environment: 'Production' },
    { production_environment: true },
    { sha: headSha },
  ])('rejects mismatched deployment %j', (patch) => {
    const original = routes()[`repos/${REPO}/deployments?sha=${baseSha}&per_page=100`];
    expect(
      collect({
        [`repos/${REPO}/deployments?sha=${baseSha}&per_page=100`]: [{ ...original[0], ...patch }],
      }),
    ).toEqual([]);
  });
  it('accepts the SHA ref emitted by Vercel only with unambiguous PR association', () => {
    const path = `repos/${REPO}/deployments?sha=${baseSha}&per_page=100`;
    expect(collect({ [path]: [{ ...routes()[path][0], ref: baseSha }] })).toHaveLength(1);
    expect(
      collect({
        [path]: [{ ...routes()[path][0], ref: baseSha }],
        [`repos/${REPO}/commits/${baseSha}/pulls?per_page=100`]: [previewPr(), pull({ number: 8 })],
      }),
    ).toEqual([]);
  });
  it('rejects changed app', () => {
    expect(
      collectInheritedPreviews({
        repository: REPO,
        pr: previewPr(),
        api: fakeApi(routes()).api,
        cwd,
        statuses: [
          {
            context: 'Vercel – product',
            state: 'success',
            description: 'Canceled by Ignored Build Step',
          },
        ],
      }),
    ).toEqual([]);
  });
  it('fails closed on a non-ancestor or unavailable git object', () => {
    expect(() =>
      collect({
        [`repos/${REPO}/pulls/7/commits?per_page=100`]: [
          { sha: conflictingMain },
          { sha: headSha },
        ],
      }),
    ).toThrow();
    expect(() =>
      collect({
        [`repos/${REPO}/pulls/7/commits?per_page=100`]: [{ sha: 'f'.repeat(40) }, { sha: headSha }],
      }),
    ).toThrow();
  });
  it('rejects fork evidence', () => {
    expect(
      collect(
        {},
        {
          ...previewPr(),
          head: { sha: headSha, repo: { full_name: 'other/repo' } },
        },
      ),
    ).toEqual([]);
  });
});

describe('commit status description', () => {
  // GitHub の commit status API は description に 4-byte Unicode を受け付けず 422 を返す。
  // required job 名は emoji 始まりなので、blocked / failed の理由をそのまま渡すと gate が
  // 判定を出せずに job ごと落ちる（#2814、PR #2813 で実発生）
  const astral = (text: string) => [...text].some((char) => (char.codePointAt(0) ?? 0) > 0xffff);

  it.each([
    '🧪 Integration Tests was skipped although the plan requires it',
    '🔍 Static Checks concluded failure',
    '📦 Unit Tests is queued',
    '🧱 DB Upgrade (shadow) was skipped although the plan requires it',
  ])('drops 4-byte Unicode from %s', (reason) => {
    const description = toStatusDescription(`blocked: integration: ${reason}`);
    expect(astral(description)).toBe(false);
    expect(description).toContain('blocked: integration:');
    expect(description).toContain(reason.replace(/^\S+\s/, ''));
  });

  it('truncates after dropping, so no surrogate half survives the 140 char limit', () => {
    const description = toStatusDescription(`${'a'.repeat(139)}🧪${'b'.repeat(40)}`);
    expect(description).toHaveLength(140);
    expect(astral(description)).toBe(false);
    expect(description.endsWith('ab')).toBe(true);
  });

  it('keeps BMP text and collapses the whitespace left behind', () => {
    expect(toStatusDescription('  pass:   all suites  satisfied ')).toBe(
      'pass: all suites satisfied',
    );
    expect(toStatusDescription('indeterminate: Unresolved input: PR context unavailable')).toBe(
      'indeterminate: Unresolved input: PR context unavailable',
    );
  });

  // ── #2816: Codex の review summary 由来の 422 ──────────────────────────
  // PR #2812（run 35184170878）/ PR #2817（run 35186212427）で実際に publish された
  // description。`@codex review` を投げた PR ではほぼ必ず emoji を含み、state に依らず
  // 422 で両 shadow status が indeterminate になった。
  const codexSummary =
    'Codex summary reports "🔄 **Running** since <relative-time datetime="2026-09-17T05:02:10.630367Z">2026-09-17T05:02:10.630367Z</relative-time';

  it('normalizes the Codex summary that actually caused the 422', () => {
    const description = toStatusDescription(codexSummary);
    expect(astral(description)).toBe(false);
    expect([...description].some(isUnsafeStatusDescriptionChar)).toBe(false);
    expect(description).toContain('Codex summary reports');
  });

  // 通す側だけの test は「もともと通っていた」で緑になる。**正規化していない生の入力が
  // 本当に不正文字を含むこと**を同じ述語で固定し、ガードが実際に何かを落としていることを示す。
  it('detects the unsafe characters in the raw string before normalization', () => {
    expect([...codexSummary].some(isUnsafeStatusDescriptionChar)).toBe(true);
    expect(astral(codexSummary)).toBe(true);
    expect(isUnsafeStatusDescriptionChar('🔄')).toBe(true);
    expect(isUnsafeStatusDescriptionChar('\n')).toBe(true);
    expect(isUnsafeStatusDescriptionChar('\u0000')).toBe(true);
    expect(isUnsafeStatusDescriptionChar('\u007f')).toBe(true);
    expect(isUnsafeStatusDescriptionChar('\ud800')).toBe(true);
    expect(isUnsafeStatusDescriptionChar('a')).toBe(false);
    expect(isUnsafeStatusDescriptionChar('–')).toBe(false); // Vercel の context は en dash を含む
  });

  it('drops control characters and lone surrogates without merging words', () => {
    expect(toStatusDescription('blocked:\u0000 integration\u0007 missing')).toBe(
      'blocked: integration missing',
    );
    expect(toStatusDescription('pass:\nall suites\r\nsatisfied')).toBe(
      'pass: all suites satisfied',
    );
    expect(toStatusDescription('pass: \ud800all suites')).toBe('pass: all suites');
  });

  it('falls back to a readable string when normalization empties the description', () => {
    expect(toStatusDescription('🔄🧪')).toBe(STATUS_DESCRIPTION_FALLBACK);
    expect(toStatusDescription('')).toBe(STATUS_DESCRIPTION_FALLBACK);
    expect(toStatusDescription(null)).toBe(STATUS_DESCRIPTION_FALLBACK);
    expect(toStatusDescription(undefined)).toBe(STATUS_DESCRIPTION_FALLBACK);
  });
});
