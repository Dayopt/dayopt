import { describe, expect, it, vi } from 'vitest';

import { ensureIntegrationMergebackPr } from './release-candidate-mergeback.mjs';

const repository = 'Dayopt/dayopt';
const mergedMainSha = 'a'.repeat(40);
const mainSha = 'b'.repeat(40);
const integrationSha = 'c'.repeat(40);
const advancedIntegrationSha = 'd'.repeat(40);

type PullRequest = {
  number: number;
  html_url: string;
  state: string;
  merged_at?: string | null;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 901,
    html_url: 'https://github.com/Dayopt/dayopt/pull/901',
    state: 'open',
    merged_at: null,
    draft: false,
    head: { ref: 'main', sha: mainSha, repo: { full_name: repository } },
    base: { ref: 'integration', sha: integrationSha, repo: { full_name: repository } },
    ...overrides,
  };
}

function fixture({
  synced = false,
  pullRequests = [] as PullRequest[],
  createResponse = pullRequest({ draft: true }),
  currentMainSha = mainSha,
  currentIntegrationSha = integrationSha,
  integrationAfterLookup = currentIntegrationSha,
}: {
  synced?: boolean;
  pullRequests?: PullRequest[];
  createResponse?: PullRequest;
  currentMainSha?: string;
  currentIntegrationSha?: string;
  integrationAfterLookup?: string;
} = {}) {
  const apiCalls: Array<[string, string, unknown]> = [];
  let integrationReads = 0;
  let selectedPr = pullRequests.find((pr) => pr.state === 'open') ?? createResponse;
  const api = vi.fn((path: string, method = 'GET', body?: unknown) => {
    apiCalls.push([path, method, body]);
    if (path === `repos/${repository}/git/ref/heads/main`)
      return { object: { sha: currentMainSha } };
    if (path === `repos/${repository}/git/ref/heads/integration`) {
      const sha = integrationReads++ === 0 ? currentIntegrationSha : integrationAfterLookup;
      return { object: { sha } };
    }
    if (path.includes('/pulls?state=all&base=integration&head=')) return pullRequests;
    if (path === `repos/${repository}/pulls` && method === 'POST') {
      selectedPr = createResponse;
      return createResponse;
    }
    if (path === `repos/${repository}/pulls/${selectedPr.number}`)
      return {
        ...selectedPr,
        base: { ...selectedPr.base, sha: integrationAfterLookup },
      };
    throw new Error(`Unexpected API call: ${method} ${path}`);
  });
  const gitCalls: string[][] = [];
  const fetchedShas = new Set<string>();
  const ready = vi.fn();
  const git = (...args: string[]) => {
    gitCalls.push(args);
    if (args[0] === 'fetch') {
      args.slice(2).forEach((sha) => fetchedShas.add(sha));
      return '';
    }
    if (args[0] !== 'merge-base') throw new Error(`Unexpected git call: ${args.join(' ')}`);
    if (!fetchedShas.has(args[2]) || !fetchedShas.has(args[3])) {
      const error = new Error('object is not available locally') as Error & { status: number };
      error.status = 128;
      throw error;
    }
    if (args[2] === args[3]) return '';
    if (args[2] === mergedMainSha && args[3] === currentMainSha && currentMainSha === mainSha)
      return '';
    if (args[2] === currentIntegrationSha && args[3] === integrationAfterLookup) return '';
    if (args[2] === currentMainSha && args[3] === currentIntegrationSha && synced) return '';
    const error = new Error('not an ancestor') as Error & { status: number };
    error.status = 1;
    throw error;
  };
  return {
    api,
    apiCalls,
    gitCalls,
    run: () =>
      ensureIntegrationMergebackPr({
        repository,
        mergedMainSha,
        api,
        git,
        ready,
      } as Parameters<typeof ensureIntegrationMergebackPr>[0]),
    ready,
  };
}

describe('ordinary release candidate merge-back PR', () => {
  it('does nothing when integration already contains current main', () => {
    const state = fixture({ synced: true });

    expect(state.run()).toEqual({
      status: 'synced',
      mainSha,
      integrationSha,
      prUrl: null,
    });
    expect(state.apiCalls).toHaveLength(2);
    expect(state.gitCalls).toContainEqual(['merge-base', '--is-ancestor', mainSha, integrationSha]);
  });

  it('opens a normal main to integration PR when main is not yet in integration', () => {
    const state = fixture();

    expect(state.run()).toMatchObject({
      status: 'pending',
      mainSha,
      integrationSha,
      prNumber: 901,
      prUrl: 'https://github.com/Dayopt/dayopt/pull/901',
    });
    expect(state.api).toHaveBeenCalledWith(
      `repos/${repository}/pulls`,
      'POST',
      expect.objectContaining({
        head: 'Dayopt:main',
        base: 'integration',
        draft: true,
      }),
    );
    expect(state.ready).toHaveBeenCalledWith(901);
    expect(
      state.apiCalls.findIndex(([path]) => path === `repos/${repository}/pulls/901`),
    ).toBeGreaterThan(state.apiCalls.findIndex(([path]) => path === `repos/${repository}/pulls`));
  });

  it('reuses the exact open PR and preserves concurrent integration advancement', () => {
    const existing = pullRequest({ draft: true });
    const state = fixture({
      pullRequests: [existing],
      integrationAfterLookup: advancedIntegrationSha,
    });

    expect(state.run()).toMatchObject({
      status: 'pending',
      prUrl: existing.html_url,
      integrationSha: advancedIntegrationSha,
    });
    expect(state.apiCalls.some(([, method]) => method === 'POST')).toBe(false);
    expect(state.ready).toHaveBeenCalledWith(existing.number);
  });

  it('uses REST merged_at for prior merged PR records and creates the next back-merge PR', () => {
    const prior = pullRequest({
      number: 800,
      state: 'closed',
      merged_at: '2026-10-04T19:00:00Z',
      head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: repository } },
    });
    const state = fixture({ pullRequests: [prior] });

    expect(state.run()).toMatchObject({ status: 'pending', prNumber: 901 });
    expect(state.apiCalls.some(([, method]) => method === 'POST')).toBe(true);
  });

  it.each([
    ['duplicate open PRs', [pullRequest(), pullRequest({ number: 902 })]],
    ['closed unmerged current PR', [pullRequest({ state: 'closed' })]],
    [
      'wrong source SHA',
      [
        pullRequest({
          head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: repository } },
        }),
      ],
    ],
    [
      'wrong base',
      [
        pullRequest({
          base: { ref: 'other', sha: integrationSha, repo: { full_name: repository } },
        }),
      ],
    ],
    [
      'fork source',
      [pullRequest({ head: { ref: 'main', sha: mainSha, repo: { full_name: 'someone/fork' } } })],
    ],
  ])('fails closed for %s', (_label, pullRequests) => {
    const state = fixture({ pullRequests });
    expect(() => state.run()).toThrow(/Merge-back held/);
  });

  it('fails closed when the verified production merge is no longer in current main', () => {
    const state = fixture({ currentMainSha: 'f'.repeat(40) });
    expect(() => state.run()).toThrow();
    expect(state.apiCalls.some(([path]) => path.includes('/pulls'))).toBe(false);
  });
});
