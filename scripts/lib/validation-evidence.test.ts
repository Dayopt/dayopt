import { describe, expect, it } from 'vitest';

import {
  PRODUCERS,
  evaluateValidation,
  formatValidationResult,
  resolveSelfProducedAfterReview,
  selectTrustedRun,
  toCommitStatus,
} from './validation-evidence.mjs';
import { createValidationPlan } from './validation-plan.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'e'.repeat(40);
const REPO = 'Dayopt/dayopt';
const CI = '.github/workflows/ci.yml';
const graph = new Map([['packages/components', new Set(['product', 'web'])]]);

const plan = (files: string[], patch: Record<string, unknown> = {}) =>
  createValidationPlan(
    {
      repository: REPO,
      prNumber: 42,
      headSha: HEAD,
      baseSha: BASE,
      testSha: 'c'.repeat(40),
      policySha: BASE,
      event: 'pull_request',
      diff: { complete: true, files, hash: 'd'.repeat(64) },
      ...patch,
    },
    { graph },
  );

type Job = { name: string; status: string; conclusion: string | null; runAttempt: number };
const job = (
  name: string,
  conclusion: string | null,
  runAttempt = 1,
): Job & { htmlUrl: string } => ({
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  runAttempt,
  htmlUrl: `https://github.com/${REPO}/actions/runs/1/job/${name}`,
});

const ciRun = (jobs: ReturnType<typeof job>[], patch: Record<string, unknown> = {}) => ({
  id: 100,
  path: CI,
  event: 'pull_request',
  headSha: HEAD,
  repository: REPO,
  runAttempt: 1,
  status: jobs.every((entry) => entry.status === 'completed') ? 'completed' : 'in_progress',
  conclusion: 'success',
  htmlUrl: `https://github.com/${REPO}/actions/runs/100`,
  jobs,
  ...patch,
});

const greenCi = () =>
  ciRun([
    job('🧭 Impact', 'success'),
    job('🔍 Static Checks', 'success'),
    job('📦 Unit Tests', 'success'),
    job('Migration Safety Notice', 'skipped'),
    job('🧪 Integration Tests', 'success'),
  ]);

const deployment = (environment: string, patch: Record<string, unknown> = {}) => ({
  id: environment.includes('product') ? 6480165896 : 6480145195,
  sha: HEAD,
  environment,
  productionEnvironment: false,
  createdAt: '2026-09-16T11:51:09Z',
  latestStatus: { state: 'success', environmentUrl: 'https://product-x.vercel.app' },
  ...patch,
});

const status = (context: string, patch: Record<string, unknown> = {}) => ({
  context,
  state: 'success',
  targetUrl: 'https://vercel.com/dayopt/product/x',
  description: 'Deployment has completed',
  ...patch,
});

const evidence = (patch: Record<string, unknown> = {}) => ({
  repository: REPO,
  headSha: HEAD,
  fetchedAt: '2026-09-17T00:00:00.000Z',
  pr: { number: 42, state: 'open', draft: false, headSha: HEAD, baseRef: 'main', fork: false },
  baseCompare: 'ahead',
  workflowRuns: [greenCi()],
  statuses: [status('Vercel – product'), status('Vercel – web')],
  deployments: [deployment('Preview – product'), deployment('Preview – web')],
  ...patch,
});

const APP_FILE = 'apps/product/src/features/timeblock/domain/a.ts';

describe('validation evidence: producer contract', () => {
  it('maps every plan suite to a trusted producer', () => {
    expect(Object.keys(plan(['README.md']).required).sort()).toEqual(Object.keys(PRODUCERS).sort());
  });

  it('selects the latest pull_request run of the trusted workflow for the head', () => {
    const runs = [
      ciRun([], { id: 1, conclusion: 'failure' }),
      ciRun([], { id: 3 }),
      ciRun([], { id: 9, path: '.github/workflows/evil.yml' }),
      ciRun([], { id: 8, headSha: OTHER }),
      ciRun([], { id: 7, event: 'workflow_dispatch' }),
      ciRun([], { id: 6, repository: 'someone/dayopt' }),
    ];
    expect(selectTrustedRun(runs, { repository: REPO, headSha: HEAD, workflow: CI })?.id).toBe(3);
  });
});

describe('validation evidence: positive paths', () => {
  it('passes a product change with green CI and matching Preview deployments', () => {
    const result = evaluateValidation({ plan: plan([APP_FILE]), evidence: evidence() });
    expect(result.verdict).toBe('pass');
    expect(result.suites.productPreview.evidence?.deploymentId).toBe(6480165896);
    expect(result.suites.productJourney.status).toBe('deferred');
    expect(result.suites.dbUpgrade.status).toBe('not-applicable');
    expect(toCommitStatus(result).state).toBe('success');
  });

  it('accepts not-applicable suites for prose-only plans even when producers are absent', () => {
    const result = evaluateValidation({
      plan: plan(['README.md']),
      evidence: evidence({
        workflowRuns: [
          ciRun([
            job('🧭 Impact', 'success'),
            job('🔍 Static Checks', 'success'),
            job('📦 Unit Tests', 'skipped'),
            job('🧪 Integration Tests', 'skipped'),
          ]),
        ],
        statuses: [],
        deployments: [],
      }),
    });
    expect(result.verdict).toBe('pass');
    expect(result.suites.productPreview.status).toBe('not-applicable');
  });

  it('does not stay pending for docs-only plans that produce no app checks', () => {
    const result = evaluateValidation({
      plan: plan(['README.md']),
      evidence: evidence({
        workflowRuns: [ciRun([job('🔍 Static Checks', 'success')])],
        statuses: [],
        deployments: [],
      }),
    });
    expect(result.verdict).toBe('pass');
  });
});

describe('validation evidence: rejected evidence', () => {
  it.each([
    ['failure', 'failed'],
    ['cancelled', 'failed'],
    ['timed_out', 'failed'],
    ['neutral', 'failed'],
    ['skipped', 'skipped'],
  ])('does not accept a required job that concluded %s', (conclusion, expected) => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun([
            job('🔍 Static Checks', 'success'),
            job('📦 Unit Tests', conclusion),
            job('🧪 Integration Tests', 'success'),
          ]),
        ],
      }),
    });
    expect(result.suites.productUnit.status).toBe(expected);
    expect(result.verdict).toBe('blocked');
    expect(toCommitStatus(result).state).toBe('failure');
  });

  it('treats a missing required job as unfulfilled, not as success', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun([job('🔍 Static Checks', 'success'), job('📦 Unit Tests', 'success')]),
        ],
      }),
    });
    expect(result.suites.integration.status).toBe('missing');
    expect(result.verdict).toBe('blocked');
  });

  it('keeps pending while the trusted run is still in progress', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        workflowRuns: [ciRun([job('🔍 Static Checks', 'success'), job('📦 Unit Tests', null)])],
      }),
    });
    expect(result.suites.productUnit.status).toBe('pending');
    expect(result.suites.integration.status).toBe('pending');
    expect(result.verdict).toBe('pending');
    expect(toCommitStatus(result).state).toBe('pending');
  });

  it('ignores same-name jobs from an untrusted workflow path', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun([], { id: 5, path: '.github/workflows/evil.yml', jobs: greenCi().jobs }),
        ],
      }),
    });
    expect(result.suites.static.status).toBe('missing');
    expect(result.verdict).toBe('blocked');
  });

  it('does not let an older successful run hide the latest failed attempt', () => {
    const failed = ciRun(
      [
        job('🔍 Static Checks', 'success'),
        job('📦 Unit Tests', 'failure', 2),
        job('🧪 Integration Tests', 'success', 2),
      ],
      { id: 200, runAttempt: 2 },
    );
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({ workflowRuns: [greenCi(), failed] }),
    });
    expect(result.suites.productUnit.status).toBe('failed');
    expect(result.suites.static.status).toBe('missing'); // stale attempt-1 job is not reused
  });

  it('rejects evidence for another head, PR or repository', () => {
    for (const patch of [
      { headSha: OTHER, pr: { ...evidence().pr, headSha: OTHER } },
      { pr: { ...evidence().pr, number: 43 } },
      { repository: 'someone/dayopt' },
      { pr: { ...evidence().pr, headSha: OTHER } },
    ]) {
      const result = evaluateValidation({ plan: plan([APP_FILE]), evidence: evidence(patch) });
      expect(result.verdict).toBe('indeterminate');
      expect(Object.values(result.suites).every((suite) => suite.status === 'indeterminate')).toBe(
        true,
      );
    }
  });

  it('never passes an indeterminate plan', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE], { policySha: HEAD }),
      evidence: evidence(),
    });
    expect(result.verdict).toBe('indeterminate');
    expect(result.reasons).toContain('policy must come from trusted base');
  });

  describe('migration PRs (#2797)', () => {
    const MIGRATION = 'supabase/migrations/20260917000000_a.sql';
    const supabasePreview = (conclusion: string | null, status = 'completed') => ({
      id: 104781444130,
      name: 'Supabase Preview',
      appSlug: 'supabase',
      headSha: HEAD,
      status,
      conclusion,
      htmlUrl: `https://github.com/${REPO}/runs/104781444130`,
    });
    const dbUpgradeRun = (conclusion: string) =>
      ciRun([...greenCi().jobs, job('🧱 DB Upgrade (shadow)', conclusion)]);

    it('requires the DB Upgrade job and an isolated Supabase branch for the product Preview', () => {
      const result = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('success')],
          checkRuns: [supabasePreview('success')],
        }),
      });
      expect(result.suites.dbFresh.status).toBe('satisfied');
      expect(result.suites.dbUpgrade.status).toBe('satisfied');
      expect(result.suites.oldConsumer.status).toBe('satisfied');
      expect(result.suites.productPreview.status).toBe('satisfied');
      expect(result.verdict).toBe('pass');
    });

    it('does not stub the upgrade path with the fresh path when the job is absent or skipped', () => {
      const absent = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({ checkRuns: [supabasePreview('success')] }),
      });
      expect(absent.suites.dbFresh.status).toBe('satisfied');
      expect(absent.suites.dbUpgrade.status).toBe('missing');
      expect(absent.verdict).toBe('blocked');
      const skipped = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('skipped')],
          checkRuns: [supabasePreview('success')],
        }),
      });
      expect(skipped.suites.oldConsumer.status).toBe('skipped');
    });

    it('rejects a product Preview without an isolated Supabase branch for a schema change', () => {
      const none = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({ workflowRuns: [dbUpgradeRun('success')] }),
      });
      expect(none.suites.productPreview.status).toBe('pending');
      expect(none.suites.productPreview.reason).toMatch(
        /Supabase Preview check has not been created/,
      );
      const skipped = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('success')],
          checkRuns: [supabasePreview('skipped')],
        }),
      });
      expect(skipped.suites.productPreview.status).toBe('failed');
      expect(skipped.suites.productPreview.reason).toMatch(/no isolated database/);
      const provisioning = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('success')],
          checkRuns: [supabasePreview(null, 'in_progress')],
        }),
      });
      expect(provisioning.suites.productPreview.status).toBe('pending');
    });

    it('ignores a same-named check from another app and keeps the real skipped verdict', () => {
      const impostor = {
        ...supabasePreview('success'),
        id: 104781444999,
        appSlug: 'another-app',
      };
      const result = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('success')],
          checkRuns: [supabasePreview('skipped'), impostor],
        }),
      });
      expect(result.suites.productPreview.status).toBe('failed');
      expect(result.suites.productPreview.reason).toMatch(/no isolated database/);
      const onlyImpostor = evaluateValidation({
        plan: plan([MIGRATION]),
        evidence: evidence({ workflowRuns: [dbUpgradeRun('success')], checkRuns: [impostor] }),
      });
      expect(onlyImpostor.suites.productPreview.status).toBe('pending');
    });

    it('does not demand a Supabase branch for app-only changes', () => {
      const result = evaluateValidation({
        plan: plan([APP_FILE]),
        evidence: evidence({ checkRuns: [supabasePreview('skipped')] }),
      });
      expect(result.suites.productPreview.status).toBe('satisfied');
    });

    it('does not trust the DB Upgrade job when the PR also changes its implementation', () => {
      const result = evaluateValidation({
        plan: plan([MIGRATION, 'scripts/ci/db-upgrade-check.mjs']),
        evidence: evidence({
          workflowRuns: [dbUpgradeRun('success')],
          checkRuns: [supabasePreview('success')],
        }),
      });
      expect(result.suites.dbUpgrade.status).toBe('self-produced');
      expect(result.suites.oldConsumer.status).toBe('self-produced');
      expect(result.suites.static.status).toBe('satisfied');
      expect(result.verdict).toBe('blocked');
    });

    it('lets a checker-only maintenance PR (no migration) pass on its unrelated suites', () => {
      const result = evaluateValidation({
        plan: plan(['scripts/ci/db-upgrade-check.mjs']),
        evidence: evidence(),
      });
      expect(result.suites.dbUpgrade.status).toBe('not-applicable');
      expect(result.suites.static.status).toBe('satisfied');
      expect(result.suites.scripts.status).toBe('satisfied');
      expect(result.verdict).toBe('pass');
    });
  });

  it.each(['.github/workflows/ci.yml', 'scripts/ci/check.mjs', '.github/actions/setup/action.yml'])(
    'does not trust a run whose producer definition %s is changed by the PR',
    (file) => {
      const result = evaluateValidation({ plan: plan([file, APP_FILE]), evidence: evidence() });
      expect(result.suites.static.status).toBe('self-produced');
      expect(result.suites.productUnit.status).toBe('self-produced');
      expect(result.suites.productPreview.status).toBe('satisfied');
      expect(result.verdict).toBe('blocked');
      expect(result.reviewCandidateReady).toBe(true);
    },
  );

  it('waits for the native job before reviewing a self-produced guardrail change', () => {
    const result = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun([
            job('🔍 Static Checks', null),
            job('📦 Unit Tests', 'success'),
            job('🧪 Integration Tests', 'skipped'),
          ]),
        ],
      }),
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reviewCandidateReady).toBe(false);
  });

  it.each(['skipped', 'cancelled', 'failure'])(
    'does not make a self-produced change review-ready when its latest producer job is %s',
    (conclusion) => {
      const result = evaluateValidation({
        plan: plan(['.github/workflows/ci.yml', APP_FILE]),
        evidence: evidence({
          workflowRuns: [
            ciRun([
              job('🔍 Static Checks', conclusion),
              job('📦 Unit Tests', 'success'),
              job('🧪 Integration Tests', 'success'),
            ]),
          ],
        }),
      });

      expect(result.verdict).toBe('blocked');
      expect(result.reviewCandidateReady).toBe(false);
      expect(
        resolveSelfProducedAfterReview(result, {
          context: 'Review policy (shadow)',
          headSha: HEAD,
          state: 'complete',
          verdict: 'satisfied',
        }).verdict,
      ).toBe('blocked');
    },
  );

  it('does not use an older run or attempt to make a self-produced change review-ready', () => {
    const result = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun(
            [
              job('🔍 Static Checks', 'success'),
              job('📦 Unit Tests', 'success'),
              job('🧪 Integration Tests', 'success'),
            ],
            { id: 100 },
          ),
          ciRun(
            [
              job('🔍 Static Checks', 'success', 1),
              job('📦 Unit Tests', 'success', 2),
              job('🧪 Integration Tests', 'success', 2),
            ],
            { id: 101, runAttempt: 2 },
          ),
        ],
      }),
    });

    expect(result.verdict).toBe('blocked');
    expect(result.reviewCandidateReady).toBe(false);
    expect(
      resolveSelfProducedAfterReview(result, {
        context: 'Review policy (shadow)',
        headSha: HEAD,
        state: 'complete',
        verdict: 'satisfied',
      }).verdict,
    ).toBe('blocked');
  });

  it('resolves self-produced evidence only after Review policy completes on the same head', () => {
    const blocked = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence(),
    });
    const result = resolveSelfProducedAfterReview(blocked, {
      context: 'Review policy (shadow)',
      headSha: HEAD,
      state: 'complete',
      verdict: 'satisfied',
    });

    expect(blocked.verdict).toBe('blocked');
    expect(result.verdict).toBe('pass');
    expect(result.reasons.join('\n')).toContain('レビュー完了により自己変更を確認した');
    expect(result.suites.static.status).toBe('review-verified');
    expect(result.reviewResolution).toMatchObject({
      context: 'Review policy (shadow)',
      headSha: HEAD,
    });
    expect(result.reviewResolution.suiteNames).toContain('static');
    expect(result.reviewResolution.suiteNames).toContain('productUnit');
    expect(result.reviewResolution.suiteNames).not.toContain('productPreview');
    expect(toCommitStatus(result).description).toContain('same-head review');
    expect(formatValidationResult(result)).toContain('review-verified');
  });

  it.each([
    ['missing review', null],
    [
      'pending review',
      { context: 'Review policy (shadow)', headSha: HEAD, state: 'pending', verdict: 'pending' },
    ],
    [
      'unresolved review thread',
      {
        context: 'Review policy (shadow)',
        headSha: HEAD,
        state: 'pending-adjudication',
        verdict: 'blocked',
      },
    ],
    [
      'stale review',
      {
        context: 'Review policy (shadow)',
        headSha: OTHER,
        state: 'complete',
        verdict: 'satisfied',
      },
    ],
    [
      'other context',
      { context: 'Other status', headSha: HEAD, state: 'complete', verdict: 'satisfied' },
    ],
  ])('keeps self-produced evidence blocked with %s', (_name, review) => {
    const blocked = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence(),
    });

    expect(resolveSelfProducedAfterReview(blocked, review).verdict).toBe('blocked');
  });

  it('keeps unrelated blockers when a same-head review is complete', () => {
    const blocked = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence(),
    });
    const withOtherFailure = {
      ...blocked,
      reasons: [...blocked.reasons, 'failed check: unrelated producer (failure)'],
    };
    const result = resolveSelfProducedAfterReview(withOtherFailure, {
      context: 'Review policy (shadow)',
      headSha: HEAD,
      state: 'complete',
      verdict: 'satisfied',
    });

    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContain('failed check: unrelated producer (failure)');
  });

  it('does not make self-produced evidence review-ready when the producer job is missing', () => {
    const result = evaluateValidation({
      plan: plan(['.github/workflows/ci.yml', APP_FILE]),
      evidence: evidence({
        workflowRuns: [
          ciRun([job('📦 Unit Tests', 'success'), job('🧪 Integration Tests', 'success')]),
        ],
      }),
    });

    expect(result.verdict).toBe('blocked');
    expect(result.reviewCandidateReady).toBe(false);
    expect(
      resolveSelfProducedAfterReview(result, {
        context: 'Review policy (shadow)',
        headSha: HEAD,
        state: 'complete',
        verdict: 'satisfied',
      }).verdict,
    ).toBe('blocked');
  });

  it('waits for every repository-ruleset context even when the plan marks it not applicable', () => {
    const guardrailPlan = plan(['.github/workflows/validation-gate.yml']);
    const pendingIntegration = evaluateValidation({
      plan: guardrailPlan,
      evidence: evidence({
        workflowRuns: [
          ciRun([
            job('🔍 Static Checks', 'success'),
            job('📦 Unit Tests', 'success'),
            job('🧪 Integration Tests', null),
          ]),
        ],
      }),
    });
    const pendingProduct = evaluateValidation({
      plan: guardrailPlan,
      evidence: evidence({
        statuses: [status('Vercel – product', { state: 'pending' }), status('Vercel – web')],
      }),
    });
    const pendingWeb = evaluateValidation({
      plan: guardrailPlan,
      evidence: evidence({
        statuses: [status('Vercel – product'), status('Vercel – web', { state: 'pending' })],
      }),
    });

    expect(pendingIntegration.reviewCandidateReady).toBe(false);
    expect(pendingProduct.reviewCandidateReady).toBe(false);
    expect(pendingWeb.reviewCandidateReady).toBe(false);
  });

  it('blocks on any failed trusted CI job even when the plan does not require it', () => {
    const result = evaluateValidation({
      plan: plan(['README.md']),
      evidence: evidence({
        workflowRuns: [
          ciRun([job('🔍 Static Checks', 'success'), job('📦 Unit Tests', 'failure')]),
        ],
      }),
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContain('failed check: 📦 Unit Tests (failure)');
  });
});

describe('validation evidence: deployments', () => {
  it('requires a Preview deployment record for the head, not only a green status', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({ deployments: [deployment('Preview – web')] }),
    });
    expect(result.suites.productPreview.status).toBe('missing');
    expect(result.verdict).toBe('blocked');
  });

  it('rejects a deployment of another head and a production environment', () => {
    const other = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        deployments: [deployment('Preview – product', { sha: OTHER }), deployment('Preview – web')],
      }),
    });
    expect(other.suites.productPreview.status).toBe('missing');
    const production = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        deployments: [
          deployment('Preview – product', { productionEnvironment: true }),
          deployment('Preview – web'),
        ],
      }),
    });
    expect(production.suites.productPreview.status).toBe('failed');
  });

  it('uses the latest deployment for the head when the same SHA deployed twice', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        deployments: [
          deployment('Preview – product', {
            id: 1,
            createdAt: '2026-09-16T03:05:50Z',
            latestStatus: { state: 'success', environmentUrl: null },
          }),
          deployment('Preview – product', {
            id: 2,
            createdAt: '2026-09-16T03:08:12Z',
            latestStatus: { state: 'failure', environmentUrl: null },
          }),
          deployment('Preview – web'),
        ],
      }),
    });
    expect(result.suites.productPreview.status).toBe('failed');
    expect(result.suites.productPreview.evidence?.deploymentId).toBe(2);
  });

  it('fails when Vercel skipped a build the plan requires', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        statuses: [
          status('Vercel – product', { description: 'Canceled by Ignored Build Step' }),
          status('Vercel – web'),
        ],
      }),
    });
    expect(result.suites.productPreview.status).toBe('failed');
  });

  it('stays pending while the deployment status is pending', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        statuses: [status('Vercel – product', { state: 'pending' }), status('Vercel – web')],
      }),
    });
    expect(result.suites.productPreview.status).toBe('pending');
    expect(result.verdict).toBe('pending');
    expect(toCommitStatus(result).state).toBe('pending');
  });
});

describe('validation evidence: PR state and base', () => {
  it('does not evaluate drafts or closed PRs', () => {
    const draft = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({ pr: { ...evidence().pr, draft: true } }),
    });
    expect(draft.verdict).toBe('not-evaluated');
    const closed = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({ pr: { ...evidence().pr, state: 'closed' } }),
    });
    expect(closed.verdict).toBe('not-evaluated');
  });

  it('requires update-branch when the base moved (strict up-to-date semantics)', () => {
    for (const baseCompare of ['behind', 'diverged', 'unknown']) {
      const result = evaluateValidation({
        plan: plan([APP_FILE]),
        evidence: evidence({ baseCompare }),
      });
      expect(result.verdict).toBe('pending');
      expect(result.reasons[0]).toMatch(/update-branch/);
    }
  });

  it('marks fork heads as indeterminate', () => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({ pr: { ...evidence().pr, fork: true } }),
    });
    expect(result.verdict).toBe('indeterminate');
  });

  it('renders reasons, links and the shadow disclaimer', () => {
    const result = evaluateValidation({ plan: plan([APP_FILE]), evidence: evidence() });
    const text = formatValidationResult(result);
    expect(text).toContain('Verdict: **pass**');
    expect(text).toContain('[run](https://github.com/Dayopt/dayopt/actions/runs/1/job/');
    expect(text).toContain('not a required check');
  });
});

describe('inherited Preview (#2807)', () => {
  const inherited = (app: string, patch: Record<string, unknown> = {}) => ({
    repository: REPO,
    prNumber: 42,
    headSha: HEAD,
    ancestorSha: OTHER,
    environment: `Preview – ${app}`,
    deploymentId: 123,
    unchanged: true,
    productionEnvironment: false,
    ...patch,
  });
  it.each(['product', 'web'])('accepts verified %s inheritance and records provenance', (app) => {
    const result = evaluateValidation({
      plan: plan([`apps/${app}/src/page.tsx`]),
      evidence: evidence({
        statuses: [status(`Vercel – ${app}`, { description: 'Canceled by Ignored Build Step' })],
        deployments: [],
        inheritedPreviews: [inherited(app)],
      }),
    });
    expect(result.suites[`${app}Preview`]).toMatchObject({
      status: 'satisfied',
      evidence: { ancestorSha: OTHER, deploymentId: 123 },
    });
  });
  it.each([
    { repository: 'other/repo' },
    { prNumber: 43 },
    { headSha: OTHER },
    { ancestorSha: HEAD },
    { unchanged: false },
    { productionEnvironment: true },
    { environment: 'Preview – web' },
  ])('rejects mismatched inheritance %j', (patch) => {
    const result = evaluateValidation({
      plan: plan([APP_FILE]),
      evidence: evidence({
        statuses: [status('Vercel – product', { description: 'Canceled by Ignored Build Step' })],
        deployments: [],
        inheritedPreviews: [inherited('product', patch)],
      }),
    });
    expect(result.suites.productPreview.status).toBe('failed');
  });
});
