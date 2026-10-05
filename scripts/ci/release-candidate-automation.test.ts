import { describe, expect, it, vi } from 'vitest';

import { autoPromoteCandidate, requiredChecksGreen } from './release-candidate-publish.mjs';

const repository = 'Dayopt/dayopt';
const candidateSha = 'a'.repeat(40);

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
});

describe('release candidate automatic promotion', () => {
  function setup({
    current = { state: 'open', head: { sha: candidateSha } },
    checks = allGreen().checks,
    statuses = allGreen().statuses,
    attempts = 3,
  }: {
    current?: Record<string, unknown>;
    checks?: ReturnType<typeof allGreen>['checks'];
    statuses?: ReturnType<typeof allGreen>['statuses'];
    attempts?: number;
  } = {}) {
    const events: string[] = [];
    const publish = vi.fn(async (input: Record<string, unknown> = {}) => {
      events.push(`publish:${input.mode}`);
      if (input.mode === 'open')
        return {
          number: 88,
          draft: true,
          head: { sha: candidateSha },
          html_url: 'https://example.test/pr/88',
        };
      return { merged: true, sha: 'b'.repeat(40) };
    });
    const ready = vi.fn((number: number) => events.push(`ready:${number}`));
    const api = vi.fn((path: string) => {
      events.push(`api:${path}`);
      if (path === `repos/${repository}/pulls/88`) return current;
      if (path === `repos/${repository}/rules/branches/main`) return rules;
      if (path === `repos/${repository}/commits/${candidateSha}/check-runs?per_page=100`)
        return { check_runs: checks };
      if (path === `repos/${repository}/commits/${candidateSha}/status?per_page=100`)
        return { statuses };
      throw new Error(`Unexpected API call: ${path}`);
    });
    const sleep = vi.fn(async () => {
      events.push('sleep');
    });
    return {
      events,
      publish,
      ready,
      api,
      sleep,
      run: () =>
        autoPromoteCandidate({
          runId: '12345',
          repository,
          publish,
          ready,
          api,
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
    expect(fixture.api).toHaveBeenCalledTimes(8);
  });
});
