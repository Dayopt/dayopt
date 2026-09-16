import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildTrustedPlan,
  collectEvidence,
  createGithubApi,
  resolveTarget,
  runValidationGate,
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
  });

  it('resolves the target PR from the workflow_run head sha and ignores closed PRs', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [
        pull({ number: 9, state: 'closed' }),
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
      env: env({ VALIDATION_RESULT_PATH: resultPath, GITHUB_RUN_ID: '1' }),
      argv: ['--pr', '7'],
      api,
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
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`repos/${REPO}/statuses/${headSha}`);
    expect(posted[0]).toContain('state=success');
    expect(posted[0]).toContain('context=Validation (shadow)');
    const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(saved.plan.identity.policySha).toBe(baseSha);
    expect(saved.result.verdict).toBe('pass');
  });

  it('blocks when the PR removed a required job from ci.yml (no self-exemption)', () => {
    const { api } = fakeApi({
      [`repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`]: [
        jobs({ '🧭 Impact': 'success', '🔍 Static Checks': 'success' }),
      ],
    });
    const posted: string[][] = [];
    const outcome = runValidationGate({
      env: env(),
      argv: ['--pr', '7'],
      api,
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
    expect(posted[0]).toContain('state=failure');
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

  it('skips events that are not associated with an open PR', () => {
    const { api } = fakeApi({ [`repos/${REPO}/commits/${headSha}/pulls?per_page=100`]: [] });
    const outcome = runValidationGate({
      env: env({
        GITHUB_EVENT_NAME: 'deployment_status',
        GITHUB_EVENT_PATH: writeEvent({ deployment: { sha: headSha } }),
      }),
      argv: [],
      api,
      cwd,
      fetchImpl: () => {},
      output: () => {},
      postStatus: () => '',
    });
    expect(outcome.skipped).toBe('no open PR for this event');
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
