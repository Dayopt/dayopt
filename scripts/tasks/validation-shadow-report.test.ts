import { describe, expect, it } from 'vitest';

import { createValidationPlan } from '../lib/validation-plan.mjs';
import {
  classifyPlan,
  collectPrRow,
  comparePlanToLegacy,
  formatReport,
  jobMinutes,
  runReport,
  sumOrNull,
} from './validation-shadow-report.mjs';

const REPO = 'Dayopt/dayopt';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const graph = new Map([['packages/components', new Set(['product', 'web'])]]);
const plan = (files: string[]) =>
  createValidationPlan(
    {
      repository: REPO,
      prNumber: 1,
      headSha: HEAD,
      baseSha: BASE,
      testSha: 'c'.repeat(40),
      policySha: BASE,
      event: 'pull_request',
      diff: { complete: true, files, hash: 'd'.repeat(64) },
    },
    { graph },
  );

describe('shadow report: classification and comparison', () => {
  it.each([
    [['README.md'], 'docs'],
    [['docs/engineering/infra.md'], 'docs'],
    [['AGENTS.md'], 'ci-policy'],
    [['.github/workflows/ci.yml'], 'ci-policy'],
    [['supabase/migrations/20260917000000_a.sql'], 'api-db'],
    [['apps/product/src/app/api/mcp/a.ts'], 'api-db'],
    [['apps/product/src/features/timeblock/domain/a.ts'], 'logic'],
    [['apps/product/src/features/x/components/A.tsx'], 'ui'],
  ])('classifies %j as %s', (files, expected) => {
    expect(classifyPlan(plan(files))).toBe(expected);
  });

  const j = (name: string, conclusion: string | null, minutes: number | null = 1) => ({
    name,
    conclusion,
    started: conclusion !== 'skipped',
    minutes,
  });
  const green = { 'Vercel – product': 'success', 'Vercel – web': 'success' };

  it('reports would-skip when a job ran but no plan suite needs it, would-add when required but skipped', () => {
    const docs = comparePlanToLegacy({
      plan: plan(['README.md']),
      jobs: [
        j('🔍 Static Checks', 'success', 2),
        j('📦 Unit Tests', 'success', 5),
        j('🧪 Integration Tests', 'skipped', 0),
      ],
      statuses: green,
    });
    expect(docs).toEqual({
      wouldSkip: ['📦 Unit Tests', 'Vercel – product', 'Vercel – web'],
      wouldAdd: [],
    });
    const policy = comparePlanToLegacy({
      plan: plan(['AGENTS.md']),
      jobs: [j('🔍 Static Checks', 'success', 2), j('📦 Unit Tests', 'skipped', 0)],
      statuses: green,
    });
    expect(policy).toEqual({
      wouldSkip: ['Vercel – product', 'Vercel – web'],
      wouldAdd: ['📦 Unit Tests'],
    });
    const migration = comparePlanToLegacy({
      plan: plan(['supabase/migrations/20260917000000_a.sql']),
      jobs: [
        j('🔍 Static Checks', 'success', 2),
        j('📦 Unit Tests', 'success', 5),
        j('🧪 Integration Tests', 'success', 4),
      ],
      statuses: green,
    });
    expect(migration!.wouldAdd).toEqual(['🧱 DB Upgrade (shadow)']);
  });

  it('counts failed / cancelled jobs as ran (they used the runner), not as skipped', () => {
    const result = comparePlanToLegacy({
      plan: plan(['README.md']),
      jobs: [j('🔍 Static Checks', 'success', 2), j('📦 Unit Tests', 'failure', 3)],
      statuses: {},
    });
    expect(result!.wouldSkip).toEqual(['📦 Unit Tests']);
  });

  it('compares Vercel deployments: would-add when the plan needs a Preview that never ran', () => {
    const result = comparePlanToLegacy({
      plan: plan(['apps/product/src/features/x/components/A.tsx']),
      jobs: [
        j('🔍 Static Checks', 'success', 2),
        j('📦 Unit Tests', 'success', 5),
        j('🧪 Integration Tests', 'skipped', 0),
      ],
      statuses: { 'Vercel – product': null, 'Vercel – web': 'success' },
    });
    expect(result!.wouldAdd).toEqual(['Vercel – product']);
    // product だけの UI 変更なので web Preview は plan 上 not-applicable = 走ったなら would-skip
    expect(result!.wouldSkip).toEqual(['Vercel – web']);
  });

  it('does not compare an indeterminate plan (never reports skippable jobs on missing input)', () => {
    const indeterminate = createValidationPlan(
      {
        repository: REPO,
        prNumber: 1,
        headSha: HEAD,
        baseSha: BASE,
        testSha: 'c'.repeat(40),
        policySha: BASE,
        event: 'pull_request',
        diff: { complete: false, files: ['README.md'], hash: 'd'.repeat(64) },
      },
      { graph },
    );
    expect(indeterminate.status).toBe('indeterminate');
    expect(
      comparePlanToLegacy({
        plan: indeterminate,
        jobs: [j('📦 Unit Tests', 'success', 5), j('🧪 Integration Tests', 'success', 4)],
        statuses: green,
      }),
    ).toBeNull();
  });

  it('rounds job minutes up like Actions billing, keeps skipped at 0 and unknown as null', () => {
    expect(
      jobMinutes({ started_at: '2026-09-16T11:49:26Z', completed_at: '2026-09-16T11:51:15Z' }),
    ).toBe(2);
    expect(jobMinutes({ conclusion: 'skipped', started_at: null, completed_at: null })).toBe(0);
    expect(
      jobMinutes({ conclusion: null, started_at: '2026-09-16T11:49:26Z', completed_at: null }),
    ).toBeNull();
    expect(sumOrNull([2, 0, 5])).toBe(7);
    expect(sumOrNull([2, null, 5])).toBeNull();
    expect(sumOrNull([])).toBeNull();
  });
});

describe('shadow report: collection and rendering', () => {
  const pr = {
    number: 2800,
    title: 'feat(ci): 共通検証計画をshadowで比較する',
    draft: false,
    changed_files: 1,
    head: { sha: HEAD },
    base: { ref: 'main', sha: BASE },
    merge_commit_sha: 'c'.repeat(40),
  };
  const routes: Record<string, unknown> = {
    [`repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=30`]: [
      { ...pr, number: 1, draft: true },
      pr,
    ],
    [`repos/${REPO}/pulls/2800/files?per_page=100`]: [{ filename: 'README.md' }],
    [`repos/${REPO}/actions/runs?head_sha=${HEAD}&per_page=50`]: [
      {
        workflow_runs: [
          {
            id: 100,
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            created_at: '2026-09-16T11:49:13Z',
            updated_at: '2026-09-16T11:52:23Z',
          },
        ],
      },
    ],
    [`repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`]: [
      {
        jobs: [
          {
            name: '🔍 Static Checks',
            conclusion: 'success',
            started_at: '2026-09-16T11:49:27Z',
            completed_at: '2026-09-16T11:52:22Z',
          },
          {
            name: '📦 Unit Tests',
            conclusion: 'success',
            started_at: '2026-09-16T11:49:26Z',
            completed_at: '2026-09-16T11:51:15Z',
          },
          {
            name: '🧪 Integration Tests',
            conclusion: 'skipped',
            started_at: null,
            completed_at: null,
          },
        ],
      },
    ],
    [`repos/${REPO}/commits/${HEAD}/status`]: {
      statuses: [
        { context: 'Vercel – product', state: 'success', description: 'Deployment has completed' },
        {
          context: 'Validation (shadow)',
          state: 'success',
          description: 'All merge-stage evidence verified',
        },
      ],
    },
  };
  const api = (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected: ${path}`);
    return structuredClone(routes[path]);
  };

  it('builds a row from read-only API data without rounding missing data to success', () => {
    const row = collectPrRow({ pr, api });
    expect(row.classification).toBe('docs');
    expect(row.planStatus).toBe('determinate');
    expect(row.legacyJobs).toEqual(['🔍 Static Checks', '📦 Unit Tests']);
    expect(row.runnerMinutes).toBe(5);
    expect(row.ciSeconds).toBe(190);
    expect(row.comparison).toEqual({
      wouldSkip: ['📦 Unit Tests', 'Vercel – product'],
      wouldAdd: [],
    });
    expect(row.shadow).toEqual({
      validation: 'success',
      validationDetail: 'All merge-stage evidence verified',
      review: '未発行',
    });
    expect(row.vercel).toEqual({ product: 'success', web: '未取得' });
  });

  it('reports runner minutes as 未取得 while a job is still running or when no CI run exists', () => {
    const running = collectPrRow({
      pr,
      api: (path: string) => {
        const value = api(path) as { jobs?: { completed_at: string | null }[] }[];
        if (path.includes('/jobs?')) value[0].jobs![1].completed_at = null;
        return value;
      },
    });
    expect(running.runnerMinutes).toBeNull();
    expect(running.legacyJobs).toEqual(['🔍 Static Checks', '📦 Unit Tests']);
    const noRun = collectPrRow({
      pr,
      api: (path: string) =>
        path.includes('/actions/runs?') ? [{ workflow_runs: [] }] : api(path),
    });
    expect(noRun.runnerMinutes).toBeNull();
    expect(noRun.legacyJobs).toEqual([]);
    const text = formatReport([running, noRun], { limit: 2, fetchedAt: 'x', policyCheckout: 'p' });
    expect(text).toContain('| 未取得 | 190 |');
    expect(text).toContain('| docs | 2 | 未取得 | 2 |');
  });

  it('labels failed jobs with their conclusion in the legacy column', () => {
    const failed = collectPrRow({
      pr,
      api: (path: string) => {
        const value = api(path) as { jobs?: { conclusion: string }[] }[];
        if (path.includes('/jobs?')) value[0].jobs![1].conclusion = 'failure';
        return value;
      },
    });
    expect(failed.legacyJobs).toEqual(['🔍 Static Checks', '📦 Unit Tests (failure)']);
    expect(failed.comparison?.wouldSkip).toContain('📦 Unit Tests');
  });

  it('skips drafts, honours --limit and renders per-class totals', () => {
    const text = runReport({
      argv: ['--limit', '10'],
      api,
      now: () => new Date('2026-09-17T00:00:00Z'),
      policyCheckout: () => 'f'.repeat(40),
    });
    expect(text).toContain('| #2800 | docs |');
    expect(text).toContain('| docs | 1 | 5 | 0 | 2 | 0 | 0 |');
    expect(text).toContain(`現 checkout \`${'f'.repeat(40)}\` の policy で遡及評価`);
    expect(text).toContain('判定は人が行う');
    expect(text).not.toContain('| #1 |');
    const json = JSON.parse(
      runReport({
        argv: ['--limit', '10', '--json'],
        api,
        now: () => new Date(0),
        policyCheckout: () => 'f'.repeat(40),
      }),
    );
    expect(json.rows).toHaveLength(1);
    expect(json.policyCheckout).toBe('f'.repeat(40));
  });

  it('marks an incomplete file listing as indeterminate instead of planning on a partial diff', () => {
    const row = collectPrRow({ pr: { ...pr, changed_files: 5 }, api });
    expect(row.planStatus).toBe('indeterminate');
    expect(row.comparison).toBeNull();
    const text = formatReport([row], { limit: 1, fetchedAt: 'x', policyCheckout: 'p' });
    expect(text).toContain('indeterminate');
    expect(text).toContain('| 未判定 | 未判定 |');
    expect(text).toContain('| docs | 1 | 5 | 0 | 0 | 0 | 1 |');
  });
});
