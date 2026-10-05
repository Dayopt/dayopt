import { describe, expect, it, vi } from 'vitest';

import { resolveNonproductionLoginTarget } from './nonproduction-login-trust.mjs';

const sha = 'a'.repeat(40);

function pr({
  number = 3024,
  state = 'open',
  draft = false,
  headSha = sha,
  headBranch = 'codex/nonprod-login',
  headRepo = 'Dayopt/dayopt',
  headRepoId = 1006944000,
  headFork = false,
  baseBranch = 'main',
} = {}) {
  return {
    number,
    state,
    draft,
    head: {
      sha: headSha,
      ref: headBranch,
      repo: { full_name: headRepo, id: headRepoId, fork: headFork },
    },
    base: {
      ref: baseBranch,
      repo: { full_name: 'Dayopt/dayopt', id: 1006944000 },
    },
  };
}

function githubFetch(currentPr: ReturnType<typeof pr>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer github-token');
    expect(url.pathname).toBe('/repos/Dayopt/dayopt/pulls/3024');
    return Response.json(currentPr);
  });
}

describe('nonproduction login trust', () => {
  it('accepts only a live same-repository PR at the event head SHA', async () => {
    const fetchImpl = githubFetch(pr());
    await expect(
      resolveNonproductionLoginTarget({
        eventName: 'pull_request_target',
        event: { pull_request: pr() },
        ref: 'refs/heads/main',
        token: 'github-token',
        fetchImpl,
      }),
    ).resolves.toEqual({
      target: 'preview',
      prNumber: 3024,
      sha,
      branchName: 'codex/nonprod-login',
      baseBranch: 'main',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['fork', pr({ headRepo: 'attacker/dayopt', headRepoId: 7, headFork: true })],
    ['stale SHA', pr({ headSha: 'b'.repeat(40) })],
    ['closed PR', pr({ state: 'closed' })],
    ['draft PR', pr({ draft: true })],
    ['unsupported base', pr({ baseBranch: 'release' })],
  ])('rejects %s without granting a target', async (_label, currentPr) => {
    await expect(
      resolveNonproductionLoginTarget({
        eventName: 'pull_request_target',
        event: { pull_request: pr() },
        ref: 'refs/heads/main',
        token: 'github-token',
        fetchImpl: githubFetch(currentPr),
      }),
    ).rejects.toThrow();
  });

  it('allows Integration dispatch only from the Integration ref', async () => {
    await expect(
      resolveNonproductionLoginTarget({
        eventName: 'workflow_dispatch',
        event: { inputs: { target: 'integration' } },
        ref: 'refs/heads/integration',
      }),
    ).resolves.toEqual({ target: 'integration' });
    await expect(
      resolveNonproductionLoginTarget({
        eventName: 'workflow_dispatch',
        event: { inputs: { target: 'integration' } },
        ref: 'refs/heads/main',
      }),
    ).rejects.toThrow('manual dispatch must use trusted Integration ref');
  });

  it('rechecks a manually selected Preview PR against its current head', async () => {
    await expect(
      resolveNonproductionLoginTarget({
        eventName: 'workflow_dispatch',
        event: {
          inputs: { target: 'preview', preview_pr: '3024', preview_sha: sha },
        },
        ref: 'refs/heads/integration',
        token: 'github-token',
        fetchImpl: githubFetch(pr()),
      }),
    ).resolves.toMatchObject({ target: 'preview', prNumber: 3024, sha });
  });
});
