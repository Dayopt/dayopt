import { describe, expect, it, vi } from 'vitest';

import {
  autoPromoteCandidate,
  countUnresolvedReviewThreads,
  requiredChecksGreen,
} from './release-candidate-publish.mjs';

const repository = 'Dayopt/dayopt';
const candidateSha = 'a'.repeat(40);
const syntheticSha = 'f'.repeat(40);

const rules = [
  { type: 'pull_request' },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: 'Unit Tests', integration_id: 101 },
        { context: 'Vercel Product', integration_id: 202 },
        { context: 'Legacy CI' },
        { context: 'Release Candidate Gate', integration_id: 303 },
      ],
    },
  },
];

const completed = (name: string, appId: number, overrides: Record<string, unknown> = {}) => ({
  name,
  app: { id: appId },
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-10-05T01:00:00.000Z',
  ...overrides,
});

const allGreen = () => ({
  checks: [
    completed('Unit Tests', 101),
    completed('Vercel Product', 202),
    completed('Release Candidate Gate', 303),
  ],
  statuses: [{ context: 'Legacy CI', state: 'success', created_at: '2026-10-05T01:00:00.000Z' }],
});

describe('release candidate required checks', () => {
  it('requires explicit success from every required context and honors GitHub App ownership', () => {
    expect(requiredChecksGreen({ rules, ...allGreen() })).toBe(true);
    expect(
      requiredChecksGreen({
        rules,
        checks: [completed('Unit Tests', 101), completed('Vercel Product', 999)],
        statuses: allGreen().statuses,
      }),
    ).toBe(false);
  });

  it.each(['pending', 'failure', 'missing'])('holds when a required check is %s', (state) => {
    const { checks, statuses } = allGreen();
    if (state === 'missing') checks.splice(0, 1);
    else if (state === 'pending')
      checks[0] = completed('Unit Tests', 101, { status: 'in_progress', conclusion: null });
    else checks[0] = completed('Unit Tests', 101, { conclusion: state });
    expect(requiredChecksGreen({ rules, checks, statuses })).toBe(false);
  });

  it.each(['skipped', 'neutral'])(
    'accepts %s for an ordinary required PR check while candidate suite evidence stays strict',
    (conclusion) => {
      const { checks, statuses } = allGreen();
      checks[0] = completed('Unit Tests', 101, { conclusion });
      expect(requiredChecksGreen({ rules, checks, statuses })).toBe(true);
    },
  );

  it('uses the newest rerun result, so a newer red attempt supersedes old green', () => {
    const { checks, statuses } = allGreen();
    checks.push(
      completed('Unit Tests', 101, {
        conclusion: 'failure',
        started_at: '2026-10-05T02:00:00.000Z',
      }),
    );
    expect(requiredChecksGreen({ rules, checks, statuses })).toBe(false);
  });

  it('fails closed when check timestamps are missing or invalid', () => {
    const { checks, statuses } = allGreen();
    checks.push(
      completed('Unit Tests', 101, {
        conclusion: 'failure',
        started_at: null,
        created_at: 'not-a-timestamp',
      }),
    );
    expect(requiredChecksGreen({ rules, checks, statuses })).toBe(false);
  });

  it('accepts legacy commit statuses when the ruleset context has no integration id', () => {
    const { checks, statuses } = allGreen();
    expect(requiredChecksGreen({ rules, checks, statuses })).toBe(true);
    expect(statuses).toContainEqual(
      expect.objectContaining({ context: 'Legacy CI', state: 'success' }),
    );
  });

  it('checks PR workflows on the synthetic merge SHA and head-only provider contexts on the head SHA', () => {
    const mergeChecks = [completed('Unit Tests', 101), completed('Release Candidate Gate', 303)];
    const headChecks = [completed('Vercel Product', 202)];
    const mergeStatuses: Array<Record<string, unknown>> = [];
    const headStatuses = [
      { context: 'Legacy CI', state: 'success', created_at: '2026-10-05T01:00:00.000Z' },
    ];

    expect(
      requiredChecksGreen({
        rules,
        checks: mergeChecks,
        statuses: mergeStatuses,
        headChecks,
        headStatuses,
      }),
    ).toBe(true);
    expect(
      requiredChecksGreen({
        rules,
        checks: [completed('Unit Tests', 101, { conclusion: 'failure' }), ...mergeChecks.slice(1)],
        statuses: mergeStatuses,
        headChecks: [completed('Unit Tests', 101), ...headChecks],
        headStatuses,
      }),
    ).toBe(false);
  });

  it('reads every review-thread page and fails closed on incomplete thread state', () => {
    const pages = [
      {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              nodes: [{ isResolved: true }],
            },
          },
        },
      },
      {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ isResolved: false }],
            },
          },
        },
      },
    ];
    const graphql = vi.fn(() => pages.shift());
    expect(countUnresolvedReviewThreads({ graphql, repository, number: 88 })).toBe(1);
    expect(graphql).toHaveBeenCalledTimes(2);

    expect(() =>
      countUnresolvedReviewThreads({
        graphql: () => ({
          repository: { pullRequest: { reviewThreads: { pageInfo: {}, nodes: [{}] } } },
        }),
        repository,
        number: 88,
      }),
    ).toThrow('review thread status is incomplete');
  });
});

describe('release candidate automatic promotion', () => {
  function setup({
    current = {
      state: 'open',
      head: { sha: candidateSha },
      base: { ref: 'main', sha: 'c'.repeat(40) },
      merge_commit_sha: syntheticSha,
      mergeable: true,
      mergeable_state: 'clean',
    },
    currentSequence,
    checks = allGreen().checks,
    statuses = allGreen().statuses,
    attempts = 3,
    threadPages = [
      {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] },
          },
        },
      },
    ],
    mergeOutcomes = [],
  }: {
    current?: Record<string, unknown>;
    currentSequence?: Array<Record<string, unknown>>;
    checks?: ReturnType<typeof allGreen>['checks'];
    statuses?: ReturnType<typeof allGreen>['statuses'];
    attempts?: number;
    threadPages?: Array<Record<string, unknown>>;
    mergeOutcomes?: unknown[];
  } = {}) {
    const events: string[] = [];
    let mergeOutcome = 0;
    const publish = vi.fn(async (input: Record<string, unknown> = {}) => {
      events.push(`publish:${input.mode}`);
      if (input.mode === 'open')
        return {
          number: 88,
          draft: true,
          head: { sha: candidateSha },
          base: { ref: 'main', sha: 'c'.repeat(40) },
          body: `Main SHA: ${'c'.repeat(40)}.`,
          html_url: 'https://example.test/pr/88',
        };
      const outcome = mergeOutcomes[mergeOutcome++];
      if (outcome instanceof Error) throw outcome;
      if (outcome !== undefined) return outcome;
      return { merged: true, sha: 'b'.repeat(40) };
    });
    const ready = vi.fn((number: number) => events.push(`ready:${number}`));
    let currentIndex = 0;
    const api = vi.fn((path: string) => {
      events.push(`api:${path}`);
      if (path === `repos/${repository}/pulls/88`) {
        const sequence = currentSequence ?? [current];
        const value = sequence[Math.min(currentIndex, sequence.length - 1)];
        currentIndex += 1;
        return value;
      }
      if (path === `repos/${repository}/rules/branches/main`) return rules;
      if (
        path === `repos/${repository}/commits/${syntheticSha}/check-runs?per_page=100` ||
        path === `repos/${repository}/commits/${candidateSha}/check-runs?per_page=100`
      )
        return { check_runs: checks };
      if (
        path === `repos/${repository}/commits/${syntheticSha}/status?per_page=100` ||
        path === `repos/${repository}/commits/${candidateSha}/status?per_page=100`
      )
        return { statuses };
      throw new Error(`Unexpected API call: ${path}`);
    });
    let threadPageIndex = 0;
    const graphql = vi.fn(() => {
      const value = threadPages[Math.min(threadPageIndex, threadPages.length - 1)];
      threadPageIndex += 1;
      return value;
    });
    const sleep = vi.fn(async () => {
      events.push('sleep');
    });
    return {
      events,
      publish,
      ready,
      api,
      graphql,
      sleep,
      run: () =>
        autoPromoteCandidate({
          runId: '12345',
          repository,
          publish,
          ready,
          api,
          graphql,
          sleep,
          attempts,
        }),
    };
  }

  it('creates a draft, marks it ready, waits for ordinary checks, then invokes the protected merge path', async () => {
    const fixture = setup();
    await expect(fixture.run()).resolves.toEqual({ merged: true, sha: 'b'.repeat(40) });
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open', 'merge']);
    expect(fixture.ready).toHaveBeenCalledExactlyOnceWith(88);
    expect(fixture.events.indexOf('ready:88')).toBeLessThan(
      fixture.events.findIndex((event) => event.includes('/pulls/88')),
    );
    expect(fixture.api).toHaveBeenCalledWith(`repos/${repository}/rules/branches/main`);
  });

  it.each([
    ['head changed', { state: 'open', head: { sha: 'c'.repeat(40) } }],
    ['PR closed', { state: 'closed', head: { sha: candidateSha } }],
  ])('holds if the promotion PR %s while waiting', async (_label, current) => {
    const fixture = setup({ current });
    await expect(fixture.run()).rejects.toThrow('promotion PR closed or changed');
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it('holds at the bounded deadline when required checks never become green', async () => {
    const fixture = setup({ checks: [], statuses: [], attempts: 2 });
    await expect(fixture.run()).rejects.toThrow('before the bounded deadline');
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);
    expect(fixture.sleep).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(fixture.api).toHaveBeenCalledTimes(12);
  });

  it('waits for unresolved review threads to be resolved before the ordinary merge', async () => {
    const fixture = setup({
      threadPages: [
        {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [{ isResolved: false }],
              },
            },
          },
        },
        {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [{ isResolved: true }],
              },
            },
          },
        },
      ],
    });
    await expect(fixture.run()).resolves.toMatchObject({ merged: true });
    expect(fixture.graphql).toHaveBeenCalledTimes(2);
    expect(fixture.sleep).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open', 'merge']);
  });

  it('fails closed when main advances or the PR has merge conflicts', async () => {
    const clean = {
      state: 'open',
      head: { sha: candidateSha },
      base: { ref: 'main', sha: 'c'.repeat(40) },
      merge_commit_sha: syntheticSha,
      mergeable: true,
      mergeable_state: 'clean',
    };
    const moved = setup({
      current: { ...clean, base: { ref: 'main', sha: 'd'.repeat(40) } },
    });
    await expect(moved.run()).rejects.toThrow('main advanced');
    expect(moved.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);

    const conflict = setup({ current: { ...clean, mergeable: false, mergeable_state: 'dirty' } });
    await expect(conflict.run()).rejects.toThrow('merge conflicts');
    expect(conflict.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);
  });

  it('waits through blocked mergeability and holds unknown merge state at the deadline', async () => {
    const clean = {
      state: 'open',
      head: { sha: candidateSha },
      base: { ref: 'main', sha: 'c'.repeat(40) },
      merge_commit_sha: syntheticSha,
      mergeable: true,
      mergeable_state: 'clean',
    };
    const blocked = { ...clean, mergeable_state: 'blocked' };
    const waiting = setup({ currentSequence: [blocked, clean] });
    await expect(waiting.run()).resolves.toMatchObject({ merged: true });
    expect(waiting.sleep).toHaveBeenCalledExactlyOnceWith(30_000);

    const unknown = setup({
      current: { ...clean, mergeable: null, mergeable_state: 'unknown' },
      attempts: 2,
    });
    await expect(unknown.run()).rejects.toThrow('before the bounded deadline');
    expect(unknown.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);
  });

  it('retries only a transient protected-branch rejection for the same open candidate', async () => {
    const rejection = Object.assign(new Error('gh pr merge failed'), {
      status: 1,
      stderr: 'HTTP 405: Protected branch rule violations found for refs/heads/main',
    });
    const fixture = setup({ mergeOutcomes: [rejection, { merged: true, sha: 'b'.repeat(40) }] });
    await expect(fixture.run()).resolves.toMatchObject({ merged: true });
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual([
      'open',
      'merge',
      'merge',
    ]);
    expect(fixture.publish.mock.calls.slice(1).map(([input]) => input?.prNumber)).toEqual([
      '88',
      '88',
    ]);

    const conflict = setup({
      mergeOutcomes: [Object.assign(new Error('HTTP 409: merge conflict'), { status: 409 })],
    });
    await expect(conflict.run()).rejects.toThrow('HTTP 409');
    expect(conflict.sleep).not.toHaveBeenCalled();
  });

  it('fails closed on incomplete review-thread evidence', async () => {
    const fixture = setup({ threadPages: [{}] });
    await expect(fixture.run()).rejects.toThrow('review thread status is incomplete');
    expect(fixture.publish.mock.calls.map(([input]) => input?.mode)).toEqual(['open']);
  });
});
