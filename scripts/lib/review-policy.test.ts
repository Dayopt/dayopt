import { describe, expect, it } from 'vitest';

import {
  CLAUDE_REVIEW_MARKER,
  REVIEWER_LOGIN,
  REVIEW_RESPONSE_TIMEOUT_MS,
  collectReviewCompletions,
  evaluateReviewPolicy,
  formatReviewPolicy,
  readReviewFailure,
  toReviewCommitStatus,
} from './review-policy.mjs';
import { createValidationPlan } from './validation-plan.mjs';

const HEAD = 'f57bf894e78e4bec945b48de4386949f95fcc95c';
const OLD = '5a552f76ed7e3f352681680c13b38aeafd435f56';
const BASE = 'b'.repeat(40);
const graph = new Map([['packages/components', new Set(['product', 'web'])]]);
const NOW = new Date('2026-09-16T12:00:00Z');

const plan = (files: string[]) =>
  createValidationPlan(
    {
      repository: 'Dayopt/dayopt',
      prNumber: 2800,
      headSha: HEAD,
      baseSha: BASE,
      testSha: 'c'.repeat(40),
      policySha: BASE,
      event: 'pull_request',
      diff: { complete: true, files, hash: 'd'.repeat(64) },
    },
    { graph },
  );

// ── scripts/ci/claude-review-post.mjs が投稿する形の fixture ───────────────
const claudeReview = (commitId: string, id = 5221740744) => ({
  id,
  authorLogin: REVIEWER_LOGIN,
  authorType: 'Bot',
  state: 'COMMENTED',
  commitId,
  submittedAt: '2026-09-16T10:56:22Z',
  htmlUrl: `https://github.com/Dayopt/dayopt/pull/2800#pullrequestreview-${id}`,
  body: `${CLAUDE_REVIEW_MARKER}\n### Claude Review\n\n**Reviewed commit:** \`${commitId}\`\n\n指摘 1 件。`,
});
const resultComment = (
  commit: string,
  result = 'completed',
  createdAt = '2026-09-16T11:28:55Z',
) => ({
  id: 5696600000,
  authorLogin: REVIEWER_LOGIN,
  authorType: 'Bot',
  body: `${CLAUDE_REVIEW_MARKER}\n**Reviewed commit:** \`${commit}\`\nResult: ${result}\nFindings: 0`,
  createdAt,
  htmlUrl: 'https://github.com/Dayopt/dayopt/pull/2802#issuecomment-5696600000',
});
const request = (createdAt: string, body = '@claude review', authorAssociation = 'OWNER') => ({
  id: 5696237053,
  authorLogin: 't3-nico',
  authorType: 'User',
  authorAssociation,
  body,
  createdAt,
  htmlUrl: 'https://github.com/Dayopt/dayopt/pull/2800#issuecomment-5696237053',
});
const highRiskSummary = (head: string, status = 'reviewed', authorAssociation = 'OWNER') => ({
  id: 5696227985,
  authorLogin: 't3-nico',
  authorType: 'User',
  authorAssociation,
  body: `[review-summary]\nhead: ${head}\nprovider: codex\nmodel: gpt-6-astra\nagent: risk-reviewer\nstatus: ${status}\nfindings: 0\n`,
  createdAt: '2026-09-16T10:47:22Z',
  htmlUrl: 'https://github.com/Dayopt/dayopt/pull/2800#issuecomment-5696227985',
});
const thread = (
  reviewId: string,
  { resolved = true, reply = true }: { resolved?: boolean; reply?: boolean } = {},
) => ({
  id: 'PRRT_1',
  isResolved: resolved,
  isOutdated: false,
  path: 'scripts/ci/validation-plan-shadow.test.ts',
  comments: [
    {
      authorLogin: REVIEWER_LOGIN,
      reviewId,
      body: `${CLAUDE_REVIEW_MARKER}\n![P2 Badge](x) Patch の変化で diff hash を検証する`,
    },
    ...(reply
      ? [
          {
            authorLogin: 't3-nico',
            authorType: 'User',
            authorAssociation: 'OWNER',
            reviewId: 'PRR_2',
            body: 'f57bf894e で対応しました。',
          },
        ]
      : []),
  ],
});

const evidence = (patch: Record<string, unknown> = {}) => ({
  headSha: HEAD,
  headCommittedAt: '2026-09-16T11:40:00Z',
  pr: { number: 2800, state: 'open', draft: false },
  reviews: [],
  comments: [],
  threads: [],
  reviewNodeIds: { '5221740744': 'PRR_1' },
  ...patch,
});

const APP = 'apps/product/src/lib/billing/a.ts';
const RLS = 'supabase/migrations/20260916_rls.sql';
const evaluate = (files: string[], ev: ReturnType<typeof evidence>, extra = {}) =>
  evaluateReviewPolicy({
    plan: plan(files),
    evidence: ev,
    now: NOW,
    validationVerdict: 'satisfied',
    ...extra,
  });

describe('review policy: requirement from plan', () => {
  it('does not require or request a review for README typos', () => {
    const result = evaluate(['README.md'], evidence());
    expect(result.verdict).toBe('not-required');
    expect(result.trigger.shouldRequest).toBe(false);
    expect(toReviewCommitStatus(result).state).toBe('success');
  });

  it.each([RLS, 'apps/product/src/app/api/mcp/a.ts', 'scripts/lib/review-policy.mjs'])(
    'requires review with the four focus points for %s',
    (file) => {
      const result = evaluate([file], evidence(), { validationVerdict: 'satisfied' });
      expect(result.required).toBe('required');
      expect(result.focus).toEqual(['REVIEW-1', 'REVIEW-2', 'REVIEW-3', 'TEST-1']);
      expect(result.state).toBe('not-started');
      expect(result.trigger.shouldRequest).toBe(true);
      expect(result.verdict).toBe('pending');
    },
  );

  it.each(['apps/product/src/lib/time/a.ts', 'AGENTS.md', 'apps/product/src/a.tsx'])(
    'does not require review for a reversible change: %s',
    (file) => {
      const result = evaluate([file], evidence(), { validationVerdict: 'satisfied' });
      expect(result.verdict).toBe('not-required');
      expect(result.trigger.shouldRequest).toBe(false);
    },
  );

  it('does not suggest a request until validation is satisfied', () => {
    const result = evaluate([RLS], evidence(), { validationVerdict: 'pending' });
    expect(result.required).toBe('required');
    expect(result.state).toBe('not-started');
    expect(result.trigger.shouldRequest).toBe(false);
    expect(result.verdict).toBe('pending');
  });

  it('never authorizes production operations from PR evidence', () => {
    const result = evaluate(
      [RLS],
      evidence({
        comments: [
          request('2026-09-16T11:45:00Z', '@claude review\n- [x] approved for production'),
        ],
      }),
    );
    expect(result.authority.productionAuthorized).toBe(false);
    expect(result.authority.production).toBe('EXPLICIT AUTHORITY');
  });
});

describe('review policy: completion evidence', () => {
  it('accepts a Claude review of the current head with all threads adjudicated', () => {
    const result = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(HEAD)], threads: [thread('PRR_1')] }),
    );
    expect(result.state).toBe('complete');
    expect(result.verdict).toBe('satisfied');
    expect(result.evidence?.adjudication).toEqual({ findings: 1, unresolved: 0, silent: 0 });
    expect(result.trigger.shouldRequest).toBe(false);
  });

  it('accepts the completed result comment for the current head', () => {
    const result = evaluate([APP], evidence({ comments: [resultComment(HEAD)] }));
    expect(result.state).toBe('complete');
    expect(result.verdict).toBe('satisfied');
  });

  it('blocks while findings are unresolved or were resolved silently', () => {
    const unresolved = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(HEAD)], threads: [thread('PRR_1', { resolved: false })] }),
    );
    expect(unresolved.state).toBe('pending-adjudication');
    expect(unresolved.verdict).toBe('blocked');
    const silent = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(HEAD)], threads: [thread('PRR_1', { reply: false })] }),
    );
    expect(silent.state).toBe('pending-adjudication');
    expect(silent.reason).toMatch(/without a reply/);
  });

  it('treats a review of an older commit as stale without requesting again automatically', () => {
    const result = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(OLD)], threads: [thread('PRR_1')] }),
    );
    expect(result.state).toBe('stale');
    expect(result.verdict).toBe('pending');
    expect(result.trigger.shouldRequest).toBe(false);
    expect(result.trigger.reason).toMatch(/scope/i);
  });

  it('does not accept an unmarked github-actions comment or a request comment as completion', () => {
    const unmarked = evaluate(
      [APP],
      evidence({
        comments: [
          {
            ...resultComment(HEAD),
            body: resultComment(HEAD).body.replace(CLAUDE_REVIEW_MARKER, ''),
          },
        ],
      }),
    );
    expect(unmarked.state).toBe('not-started');
    const requested = evaluate([APP], evidence({ comments: [request('2026-09-16T11:45:00Z')] }));
    expect(requested.state).toBe('pending');
    expect(requested.trigger.shouldRequest).toBe(false);
    expect(requested.trigger.reason).toMatch(/already exists/);
  });

  it('reports unknown after a request stays unanswered beyond the timeout', () => {
    const late = new Date(Date.parse('2026-09-16T11:45:00Z') + REVIEW_RESPONSE_TIMEOUT_MS + 1);
    const result = evaluate([APP], evidence({ comments: [request('2026-09-16T11:45:00Z')] }), {
      now: late,
    });
    expect(result.state).toBe('unknown');
    expect(result.verdict).toBe('blocked');
    expect(result.reason).toMatch(/already-recorded review evidence/);
  });

  it('ignores requests made before the current head was pushed', () => {
    const result = evaluate([APP], evidence({ comments: [request('2026-09-16T10:48:06Z')] }));
    expect(result.state).toBe('not-started');
    expect(result.trigger.shouldRequest).toBe(true);
  });

  it('reports failed only when the workflow failed for the current head', () => {
    const failed = evaluate([APP], evidence({ comments: [resultComment(HEAD, 'failed')] }));
    expect(failed.state).toBe('failed');
    expect(failed.verdict).toBe('blocked');
    const oldFailure = evaluate([APP], evidence({ comments: [resultComment(OLD, 'failed')] }));
    expect(oldFailure.state).toBe('not-started');
    const recovered = evaluate(
      [APP],
      evidence({ comments: [resultComment(HEAD, 'failed'), resultComment(HEAD)] }),
    );
    expect(recovered.state).toBe('complete');
  });

  it('rejects a bot response whose target commit cannot be determined and other bots', () => {
    const mismatch = evaluate(
      [APP],
      evidence({
        reviews: [
          {
            ...claudeReview(HEAD),
            body: `${CLAUDE_REVIEW_MARKER}\n**Reviewed commit:** \`deadbeef1\``,
            submittedAt: '2026-09-16T11:55:00Z', // head 切替後の応答
          },
        ],
      }),
    );
    expect(mismatch.state).toBe('unknown');
    expect(mismatch.verdict).toBe('blocked');
    const otherBot = evaluate(
      [APP],
      evidence({ reviews: [{ ...claudeReview(HEAD), authorLogin: 'other-bot[bot]' }] }),
    );
    expect(otherBot.state).toBe('not-started');
    // 人間が marker を貼っても reviewer の投稿にはならない
    const forged = evaluate(
      [APP],
      evidence({
        comments: [{ ...resultComment(HEAD), authorLogin: 't3-nico', authorType: 'User' }],
      }),
    );
    expect(forged.state).toBe('not-started');
  });

  it('matches GraphQL thread authors without the [bot] suffix', () => {
    const graphqlThread = {
      ...thread('PRR_1', { resolved: false }),
      comments: [
        { authorLogin: 'github-actions', reviewId: 'PRR_1', body: `${CLAUDE_REVIEW_MARKER}\nP2` },
      ],
    };
    const result = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(HEAD)], threads: [graphqlThread] }),
    );
    expect(result.state).toBe('pending-adjudication');
  });

  it('excludes dismissed or pending reviews from completion evidence', () => {
    for (const state of ['DISMISSED', 'PENDING']) {
      const result = evaluate([APP], evidence({ reviews: [{ ...claudeReview(HEAD), state }] }));
      expect(result.state, state).toBe('not-started');
    }
  });

  it('prefers the observed head time over commit metadata when matching requests', () => {
    const result = evaluate(
      [APP],
      evidence({
        headCommittedAt: '2026-09-16T09:00:00Z',
        headObservedAt: '2026-09-16T11:50:00Z',
        comments: [request('2026-09-16T11:45:00Z')],
      }),
    );
    expect(result.state).toBe('not-started');
  });

  it('ignores review requests from untrusted authors', () => {
    const result = evaluate(
      [APP],
      evidence({ comments: [request('2026-09-16T11:45:00Z', '@claude review', 'NONE')] }),
    );
    expect(result.state).toBe('not-started');
    expect(result.trigger.shouldRequest).toBe(true);
  });

  it('ignores a target-less response posted before the head switch', () => {
    const stale = {
      ...claudeReview(OLD),
      body: `${CLAUDE_REVIEW_MARKER}\n**Reviewed commit:** \`deadbeef1\``,
      submittedAt: '2026-09-16T10:00:00Z',
    };
    const before = evaluate([APP], evidence({ reviews: [stale] }));
    expect(before.state).toBe('not-started');
    const after = evaluate(
      [APP],
      evidence({ reviews: [{ ...stale, submittedAt: '2026-09-16T11:55:00Z' }] }),
    );
    expect(after.state).toBe('unknown');
  });

  it('does not count replies from outsiders or other bots as adjudication', () => {
    const outsiderReply = {
      ...thread('PRR_1'),
      comments: [
        { authorLogin: REVIEWER_LOGIN, reviewId: 'PRR_1', body: `${CLAUDE_REVIEW_MARKER}\nP2` },
        {
          authorLogin: 'stranger',
          authorType: 'User',
          authorAssociation: 'NONE',
          reviewId: null,
          body: 'lgtm',
        },
      ],
    };
    const result = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(HEAD)], threads: [outsiderReply] }),
    );
    expect(result.state).toBe('pending-adjudication');
    expect(result.reason).toMatch(/without a reply/);
  });

  it('applies adjudication to the alternative review path as well', () => {
    const late = new Date(Date.parse('2026-09-16T11:45:00Z') + REVIEW_RESPONSE_TIMEOUT_MS + 1);
    const silentThread = { ...thread('PRR_9', { reply: false }), id: 'PRRT_alt' };
    const result = evaluate(
      [APP],
      evidence({
        comments: [request('2026-09-16T11:45:00Z'), highRiskSummary(HEAD)],
        threads: [silentThread],
      }),
      { now: late },
    );
    expect(result.state).toBe('pending-adjudication');
    expect(result.verdict).toBe('blocked');
  });

  it('lets a trusted fixed-diff review satisfy the policy when Claude review is unavailable', () => {
    const late = new Date(Date.parse('2026-09-16T11:45:00Z') + REVIEW_RESPONSE_TIMEOUT_MS + 1);
    const result = evaluate(
      [APP],
      evidence({ comments: [request('2026-09-16T11:45:00Z'), highRiskSummary(HEAD)] }),
      { now: late },
    );
    expect(result.state).toBe('complete');
    expect(result.verdict).toBe('satisfied');
    expect(result.reason).toMatch(/Existing fixed-diff review evidence/);
  });

  it('does not let a fixed-diff summary replace a missing or stale review request', () => {
    const notStarted = evaluate([APP], evidence({ comments: [highRiskSummary(HEAD)] }));
    expect(notStarted.state).toBe('not-started');
    expect(notStarted.verdict).toBe('pending');
    expect(notStarted.trigger.shouldRequest).toBe(true);

    const stale = evaluate(
      [APP],
      evidence({ reviews: [claudeReview(OLD)], comments: [highRiskSummary(HEAD)] }),
    );
    expect(stale.state).toBe('stale');
    expect(stale.verdict).toBe('pending');
    expect(stale.trigger.shouldRequest).toBe(false);
  });

  it('does not request a review of a blocked head or a draft', () => {
    const blocked = evaluate([APP], evidence(), { validationVerdict: 'blocked' });
    expect(blocked.trigger.shouldRequest).toBe(false);
    const draft = evaluate([APP], evidence({ pr: { number: 2800, state: 'open', draft: true } }));
    expect(draft.trigger.shouldRequest).toBe(false);
  });
});

describe('review policy: optional fixed-diff evidence', () => {
  it('accepts the current Claude review on protected paths without an additional review', () => {
    const missing = evaluate([RLS], evidence({ reviews: [claudeReview(HEAD)] }));
    expect(missing.state).toBe('complete');
    expect(missing.highRisk?.status).toBe('missing');
    expect(missing.verdict).toBe('satisfied');
    const stale = evaluate(
      [RLS],
      evidence({ reviews: [claudeReview(HEAD)], comments: [highRiskSummary(OLD)] }),
    );
    expect(stale.highRisk?.status).toBe('stale');
    expect(stale.verdict).toBe('satisfied');
    const partial = evaluate(
      [RLS],
      evidence({
        reviews: [claudeReview(HEAD)],
        comments: [highRiskSummary(HEAD, 'risk-reviewer=partial')],
      }),
    );
    expect(partial.highRisk?.status).toBe('partial');
    expect(partial.verdict).toBe('satisfied');
    const ok = evaluate(
      [RLS],
      evidence({ reviews: [claudeReview(HEAD)], comments: [highRiskSummary(HEAD)] }),
    );
    expect(ok.highRisk?.status).toBe('satisfied');
    expect(ok.verdict).toBe('satisfied');
  });

  it('still requires a current Claude review and adjudication on protected paths', () => {
    expect(evaluate([RLS], evidence()).verdict).toBe('pending');
    expect(evaluate([RLS], evidence({ reviews: [claudeReview(OLD)] })).verdict).toBe('pending');
    const unresolved = evaluate(
      [RLS],
      evidence({ reviews: [claudeReview(HEAD)], threads: [thread('PRR_1', { resolved: false })] }),
    );
    expect(unresolved.state).toBe('pending-adjudication');
    expect(unresolved.verdict).toBe('blocked');
  });

  it('rejects a review-summary from a non-member and non-strict status forms', () => {
    const outsider = evaluate(
      [RLS],
      evidence({
        reviews: [claudeReview(HEAD)],
        comments: [highRiskSummary(HEAD, 'reviewed', 'NONE')],
      }),
    );
    expect(outsider.highRisk?.status).toBe('missing');
    for (const [status, expected] of [
      ['risk-reviewer=reviewed, behavior-verifier=reviewed', 'satisfied'],
      ['risk-reviewer=reviewed, behavior-verifier=unknown', 'unknown'],
      ['not-reviewed', 'unknown'],
      ['risk-reviewer=reviewed, behavior-verifier=not-run', 'stale'],
      ['', 'unknown'],
      ['reviewed, reviewed', 'unknown'],
      ['reviewed, risk-reviewer=reviewed', 'unknown'],
    ] as const) {
      const result = evaluate(
        [RLS],
        evidence({ reviews: [claudeReview(HEAD)], comments: [highRiskSummary(HEAD, status)] }),
      );
      expect(result.highRisk?.status, status).toBe(expected);
    }
  });

  it('ignores a bot-authored review-summary marker', () => {
    const forged = evaluate(
      [RLS],
      evidence({
        reviews: [claudeReview(HEAD)],
        comments: [{ ...highRiskSummary(HEAD), authorLogin: 'x[bot]', authorType: 'Bot' }],
      }),
    );
    expect(forged.highRisk?.status).toBe('missing');
  });
});

describe('review policy: parsers and rendering', () => {
  it('parses completions and failures from the posted formats', () => {
    const completions = collectReviewCompletions(
      evidence({
        reviews: [claudeReview(OLD)],
        comments: [resultComment(HEAD), resultComment(HEAD, 'failed')],
      }),
    );
    expect(completions.map((entry) => [entry.kind, entry.target])).toEqual([
      ['review', OLD],
      ['comment', HEAD],
    ]);
    expect(
      readReviewFailure(evidence({ comments: [resultComment(HEAD, 'failed')] }), HEAD),
    ).not.toBe(null);
    expect(readReviewFailure(evidence({ comments: [resultComment(HEAD)] }), HEAD)).toBe(null);
  });

  it('accepts only a request on the first line, matching the workflow trigger', () => {
    const quoted = evaluate(
      [APP],
      evidence({ comments: [request('2026-09-16T11:45:00Z', 'まだ\n@claude review')] }),
    );
    expect(quoted.state).toBe('not-started');
    const legacy = evaluate(
      [APP],
      evidence({ comments: [request('2026-09-16T11:45:00Z', '@codex review')] }),
    );
    expect(legacy.state).toBe('not-started');
  });

  it('renders the shadow summary with trigger and authority lines', () => {
    const text = formatReviewPolicy(evaluate([APP], evidence({ reviews: [claudeReview(HEAD)] })));
    expect(text).toContain('Verdict: **satisfied** (complete)');
    expect(text).toContain('production=EXPLICIT AUTHORITY (authorized: false)');
    expect(text).toContain('no review is requested automatically');
  });
});
