import { describe, expect, it } from 'vitest';

import { createValidationPlan } from '../lib/validation-plan.mjs';
import {
  classifyPlan,
  collectPrRow,
  comparePlanToLegacy,
  formatReport,
  jobMinutes,
  latestStatusByContext,
  listRecentPulls,
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
    [['docs/engineering/data/db/rls-snapshot.md'], 'api-db'],
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
  const ok = { state: 'success', ran: true };
  const green = { 'Vercel – product': ok, 'Vercel – web': ok };

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
    // fixture は `.claude/settings.json`。文書だけの policy 変更では ci.yml が
    // `📦 Unit Tests` を skip し、plan もそれに合わせて required にしない（#2821）ため、
    // 「required なのに skip された」を再現するには実行可能な policy ファイルを使う
    const policy = comparePlanToLegacy({
      plan: plan(['.claude/settings.json']),
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

  it('treats a cancelled job that never started as absent (would-add when required)', () => {
    const result = comparePlanToLegacy({
      plan: plan(['.claude/settings.json']),
      jobs: [
        j('🔍 Static Checks', 'success', 2),
        { name: '📦 Unit Tests', conclusion: 'cancelled', started: false, minutes: null },
      ],
      statuses: green,
    });
    expect(result!.wouldAdd).toEqual(['📦 Unit Tests']);
    expect(result!.wouldSkip).not.toContain('📦 Unit Tests');
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
      statuses: { 'Vercel – product': null, 'Vercel – web': ok },
    });
    expect(result!.wouldAdd).toEqual(['Vercel – product']);
    // product だけの UI 変更なので web Preview は plan 上 not-applicable = 走ったなら would-skip
    expect(result!.wouldSkip).toEqual(['Vercel – web']);
  });

  it('treats an Ignored Build Step status as a Preview that did not run', () => {
    const ignored = { state: 'ignored', ran: false };
    const result = comparePlanToLegacy({
      plan: plan(['apps/product/src/features/x/components/A.tsx']),
      jobs: [j('🔍 Static Checks', 'success', 2), j('📦 Unit Tests', 'success', 5)],
      statuses: { 'Vercel – product': ignored, 'Vercel – web': ignored },
    });
    expect(result!.wouldAdd).toEqual(['Vercel – product']);
    expect(result!.wouldSkip).not.toContain('Vercel – web');
  });

  it('does not compare while the legacy observation is incomplete (no or unfinished CI run)', () => {
    expect(
      comparePlanToLegacy({
        plan: plan(['README.md']),
        jobs: [],
        statuses: green,
        legacyComplete: false,
      }),
    ).toBeNull();
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

describe('shadow report: pull listing', () => {
  it('stops paging once enough non-draft main PRs are collected and never uses --paginate', () => {
    const requested: string[] = [];
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        number: n * 1000 + i,
        draft: i % 2 === 1,
        base: { ref: i % 5 === 0 ? 'release' : 'main' },
      }));
    const api = (path: string, paginate?: boolean) => {
      expect(paginate).toBeFalsy();
      requested.push(path);
      const n = Number(path.match(/&page=(\d+)/)![1]);
      return n <= 3 ? page(n) : [];
    };
    const pulls = listRecentPulls({ api, limit: 5 });
    expect(pulls).toHaveLength(5);
    expect(pulls.every((pr) => !pr.draft && pr.base.ref === 'main')).toBe(true);
    expect(requested).toHaveLength(1);
    const all = listRecentPulls({ api, limit: 500 });
    // 3 page 分（各 40 件が該当）で尽きる。空 page で止まり、上限 page 数を超えない
    expect(all).toHaveLength(120);
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
    [`repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [
      { ...pr, number: 1, draft: true },
      pr,
    ],
    [`repos/${REPO}/compare/${BASE}...${HEAD}?per_page=100`]: [
      { files: [{ filename: 'README.md' }] },
    ],
    [`repos/${REPO}/actions/runs?head_sha=${HEAD}&per_page=50`]: [
      {
        workflow_runs: [
          {
            id: 100,
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            status: 'completed',
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
    [`repos/${REPO}/commits/${HEAD}/statuses?per_page=100`]: [
      // 古い pending が後ろに並んでいても id 最大の terminal を選ぶ
      {
        id: 3,
        context: 'Vercel – product',
        state: 'success',
        description: 'Deployment has completed',
      },
      { id: 1, context: 'Vercel – product', state: 'pending', description: 'Deployment started' },
      {
        id: 2,
        context: 'Validation (shadow)',
        state: 'success',
        description: 'All merge-stage evidence verified',
      },
    ],
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

  it('distinguishes ordinary failures, self-produced blockers, and review-confirmed self-changes', () => {
    const withStatuses = (validationState: string, validationDetail: string, reviewState: string) =>
      collectPrRow({
        pr,
        api: (path: string) =>
          path.endsWith(`/commits/${HEAD}/statuses?per_page=100`)
            ? [
                {
                  id: 4,
                  context: 'Validation (shadow)',
                  state: validationState,
                  description: validationDetail,
                },
                {
                  id: 5,
                  context: 'Review policy (shadow)',
                  state: reviewState,
                  description: 'review fixture',
                },
              ]
            : api(path),
      });
    const ordinaryFailure = withStatuses(
      'failure',
      'blocked: static: required job failed',
      'pending',
    );
    const selfProduced = withStatuses(
      'failure',
      'blocked: static: This PR changes the producer definition (package.json)',
      'pending',
    );
    const reviewed = withStatuses(
      'success',
      'Self-produced change verified after same-head review (static)',
      'success',
    );

    const report = formatReport([ordinaryFailure, selfProduced, reviewed], {
      limit: 3,
      fetchedAt: 'x',
      policyCheckout: 'p',
    });

    expect(report).toContain('| failure | pending |');
    expect(report).toContain('| failure (self-produced; Review pending) | pending |');
    expect(report).toContain('| success (review-confirmed self-change) | success |');
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
    expect(text).toContain('| docs | 2 | 未取得 | 2 | 2 | 0 | 1 |');
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

  it('picks the latest status per context across pages', () => {
    const latest = latestStatusByContext([
      { id: 5, context: 'a', state: 'pending' },
      { id: 9, context: 'a', state: 'success' },
      { id: 7, context: 'b', state: 'failure' },
      { context: null },
    ]);
    expect(latest.get('a')?.state).toBe('success');
    expect(latest.get('b')?.id).toBe(7);
    expect(latest.size).toBe(2);
  });

  it('marks a diff that hits the compare API file cap as indeterminate instead of planning on a partial diff', () => {
    const row = collectPrRow({
      pr,
      api: (path: string) =>
        path.includes('/compare/')
          ? [{ files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) }]
          : api(path),
    });
    expect(row.planStatus).toBe('indeterminate');
    expect(row.classification).toBe('未判定');
    expect(row.comparison).toBeNull();
    const text = formatReport([row], { limit: 1, fetchedAt: 'x', policyCheckout: 'p' });
    expect(text).toContain('indeterminate');
    expect(text).toContain('| 未判定 | 未判定 |');
    // 分類別集計にも docs として混ぜない
    expect(text).toContain('| 未判定 | 1 | 5 | 0 | 0 | 0 | 1 |');
    expect(text).not.toContain('| docs | 1 |');
  });
});
