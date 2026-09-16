import { describe, expect, it } from 'vitest';

import { createValidationPlan } from '../lib/validation-plan.mjs';
import {
  classifyPlan,
  collectPrRow,
  comparePlanToLegacy,
  formatReport,
  jobMinutes,
  runReport,
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

  it('reports would-skip when a job ran but no plan suite needs it, would-add when required but skipped', () => {
    const docs = comparePlanToLegacy({
      plan: plan(['README.md']),
      jobs: [
        { name: '🔍 Static Checks', conclusion: 'success', minutes: 2 },
        { name: '📦 Unit Tests', conclusion: 'success', minutes: 5 },
        { name: '🧪 Integration Tests', conclusion: 'skipped', minutes: 0 },
      ],
    });
    expect(docs).toEqual({ wouldSkip: ['📦 Unit Tests'], wouldAdd: [] });
    const policy = comparePlanToLegacy({
      plan: plan(['AGENTS.md']),
      jobs: [
        { name: '🔍 Static Checks', conclusion: 'success', minutes: 2 },
        { name: '📦 Unit Tests', conclusion: 'skipped', minutes: 0 },
      ],
    });
    expect(policy).toEqual({ wouldSkip: [], wouldAdd: ['📦 Unit Tests'] });
    const migration = comparePlanToLegacy({
      plan: plan(['supabase/migrations/20260917000000_a.sql']),
      jobs: [
        { name: '🔍 Static Checks', conclusion: 'success', minutes: 2 },
        { name: '📦 Unit Tests', conclusion: 'success', minutes: 5 },
        { name: '🧪 Integration Tests', conclusion: 'success', minutes: 4 },
      ],
    });
    expect(migration.wouldAdd).toEqual(['🧱 DB Upgrade (shadow)']);
  });

  it('rounds job minutes up like Actions billing and treats missing timestamps as 0, not success', () => {
    expect(
      jobMinutes({ started_at: '2026-09-16T11:49:26Z', completed_at: '2026-09-16T11:51:15Z' }),
    ).toBe(2);
    expect(jobMinutes({ started_at: null, completed_at: null })).toBe(0);
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
        { context: 'Vercel – product', description: 'Deployment has completed' },
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
    expect(row.wouldSkip).toEqual(['📦 Unit Tests']);
    expect(row.shadow).toEqual({
      validation: 'success',
      validationDetail: 'All merge-stage evidence verified',
      review: '未発行',
    });
    expect(row.vercel.web).toBe('未取得');
  });

  it('skips drafts, honours --limit and renders per-class totals', () => {
    const text = runReport({
      argv: ['--limit', '10'],
      api,
      now: () => new Date('2026-09-17T00:00:00Z'),
    });
    expect(text).toContain('| #2800 | docs |');
    expect(text).toContain('| docs | 1 | 5 | 1 | 0 |');
    expect(text).toContain('判定は人が行う');
    expect(text).not.toContain('| #1 |');
    const json = JSON.parse(
      runReport({ argv: ['--limit', '10', '--json'], api, now: () => new Date(0) }),
    );
    expect(json.rows).toHaveLength(1);
  });

  it('marks an incomplete file listing as indeterminate instead of planning on a partial diff', () => {
    const row = collectPrRow({ pr: { ...pr, changed_files: 5 }, api });
    expect(row.planStatus).toBe('indeterminate');
    expect(formatReport([row], { limit: 1, fetchedAt: 'x' })).toContain('indeterminate');
  });
});
