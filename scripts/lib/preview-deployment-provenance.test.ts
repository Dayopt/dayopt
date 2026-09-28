import { describe, expect, it, vi } from 'vitest';

import { observeProductPreviewDeployment } from './preview-deployment-provenance.mjs';

const githubToken = 'read-only-github-token';
const sha = 'a'.repeat(40);
const branchName = 'codex/preview-provenance-2910';
const prNumber = 2910;
const deploymentId = 'dpl_abc123XYZ';
const githubDeploymentId = 801;
const repositoryUrl = 'https://api.github.com/repos/Dayopt/dayopt';
const vercelCreator = { id: 35613825, login: 'vercel[bot]', type: 'Bot' };
const observedAt = new Date('2026-09-29T00:00:10.000Z');

function fixture(overrides: Record<string, unknown> = {}) {
  const pullRequest = {
    number: prNumber,
    state: 'open',
    draft: false,
    head: {
      ref: branchName,
      sha,
      repo: { id: 1006944000, full_name: 'Dayopt/dayopt', fork: false },
    },
    base: { ref: 'main', repo: { id: 1006944000, full_name: 'Dayopt/dayopt' } },
  };
  const commitStatuses = [
    {
      id: 105,
      state: 'success',
      context: 'Vercel – product',
      target_url: `https://vercel.com/dayopt/product/${deploymentId.slice(4)}`,
      created_at: '2026-09-29T00:00:05.000Z',
      creator: { ...vercelCreator },
    },
    {
      id: 104,
      state: 'success',
      context: 'Other check',
      target_url: 'https://example.test/',
      created_at: '2026-09-29T00:00:04.000Z',
      creator: { id: 42, login: 'someone', type: 'User' },
    },
  ];
  const deployments = [
    {
      id: githubDeploymentId,
      sha,
      ref: sha,
      task: 'deploy',
      environment: 'Preview – product',
      original_environment: 'Preview – product',
      production_environment: false,
      repository_url: repositoryUrl,
      created_at: '2026-09-29T00:00:00.000Z',
      creator: { ...vercelCreator },
      performed_via_github_app: null,
      payload: {},
    },
  ];
  const deploymentStatuses = [
    {
      id: 205,
      state: 'success',
      environment: 'Preview – product',
      environment_url: 'https://product-abc123-dayopt.vercel.app',
      deployment_url: `${repositoryUrl}/deployments/${githubDeploymentId}`,
      repository_url: repositoryUrl,
      created_at: '2026-09-29T00:00:05.000Z',
      creator: { ...vercelCreator },
    },
  ];
  const state = {
    pullRequest,
    commitStatuses,
    deployments,
    deploymentStatuses,
    ...overrides,
  } as {
    pullRequest: Record<string, any>;
    commitStatuses: Record<string, any>[];
    deployments: Record<string, any>[];
    deploymentStatuses: Record<string, any>[];
    fetchOverride?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  };

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${githubToken}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');

    if (state.fetchOverride) return state.fetchOverride(url, init!);
    if (url.pathname === `/repos/Dayopt/dayopt/pulls/${prNumber}`) {
      return Response.json(state.pullRequest);
    }
    if (url.pathname === `/repos/Dayopt/dayopt/commits/${sha}/statuses`) {
      return Response.json(state.commitStatuses);
    }
    if (url.pathname === '/repos/Dayopt/dayopt/deployments') {
      expect(url.searchParams.get('sha')).toBe(sha);
      expect(url.searchParams.get('environment')).toBe('Preview – product');
      return Response.json(state.deployments);
    }
    if (url.pathname === `/repos/Dayopt/dayopt/deployments/${githubDeploymentId}/statuses`) {
      return Response.json(state.deploymentStatuses);
    }
    throw new Error(`unexpected request path ${url.pathname}`);
  });
  return { state, fetchImpl };
}

function options(fetchImpl: typeof fetch) {
  return {
    sha,
    deploymentId,
    branchName,
    prNumber,
    githubToken,
    fetchImpl,
    now: () => observedAt,
  };
}

describe('Product Preview deployment provenance', () => {
  it('authenticates the exact internal PR and binds current Vercel status, GitHub deployment, and immutable origin', async () => {
    const world = fixture();
    const evidence = await observeProductPreviewDeployment(options(world.fetchImpl));

    expect(world.fetchImpl).toHaveBeenCalledTimes(4);
    expect(evidence).toEqual({
      origin: 'https://product-abc123-dayopt.vercel.app',
      providerEvidence: {
        provider: 'vercel',
        repository: 'Dayopt/dayopt',
        environment: 'Preview – product',
        sha,
        branchName,
        prNumber,
        vercelDeploymentId: deploymentId,
        githubDeploymentId,
        githubDeploymentStatusId: 205,
        githubCommitStatusId: 105,
        creatorId: 35613825,
        deploymentCreatedAt: '2026-09-29T00:00:00.000Z',
        deploymentStatusCreatedAt: '2026-09-29T00:00:05.000Z',
        commitStatusCreatedAt: '2026-09-29T00:00:05.000Z',
        observedAt: '2026-09-29T00:00:10.000Z',
      },
    });
    expect(JSON.stringify(evidence)).not.toContain(githubToken);
    const urls = world.fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map(({ pathname }) => pathname)).toEqual([
      `/repos/Dayopt/dayopt/pulls/${prNumber}`,
      `/repos/Dayopt/dayopt/commits/${sha}/statuses`,
      '/repos/Dayopt/dayopt/deployments',
      `/repos/Dayopt/dayopt/deployments/${githubDeploymentId}/statuses`,
    ]);
  });

  it.each([
    ['forked head', (state: any) => (state.pullRequest.head.repo.fork = true)],
    [
      'external head repository',
      (state: any) => (state.pullRequest.head.repo.full_name = 'attacker/dayopt'),
    ],
    ['closed PR', (state: any) => (state.pullRequest.state = 'closed')],
    ['draft PR', (state: any) => (state.pullRequest.draft = true)],
    ['stale SHA', (state: any) => (state.pullRequest.head.sha = 'b'.repeat(40))],
    ['different branch', (state: any) => (state.pullRequest.head.ref = 'codex/other')],
  ])('rejects an unauthenticated or mismatched candidate PR (%s)', async (_name, change) => {
    const world = fixture();
    change(world.state);
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'candidate PR',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows cleanup provenance to survive a closed PR and advanced head only with the recovery flag', async () => {
    const world = fixture();
    world.state.pullRequest.state = 'closed';
    world.state.pullRequest.head.sha = 'b'.repeat(40);
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'candidate PR is not open and ready',
    );
    const recoveryWorld = fixture();
    recoveryWorld.state.pullRequest.state = 'closed';
    recoveryWorld.state.pullRequest.head.sha = 'b'.repeat(40);
    await expect(
      observeProductPreviewDeployment({
        ...options(recoveryWorld.fetchImpl),
        requireRunnablePullRequest: false,
      }),
    ).resolves.toMatchObject({
      origin: 'https://product-abc123-dayopt.vercel.app',
      providerEvidence: { sha, prNumber },
    });
  });

  it('recovery mode still rejects a different PR branch', async () => {
    const world = fixture();
    world.state.pullRequest.state = 'closed';
    world.state.pullRequest.head.sha = 'b'.repeat(40);
    world.state.pullRequest.head.ref = 'codex/another-branch';
    await expect(
      observeProductPreviewDeployment({
        ...options(world.fetchImpl),
        requireRunnablePullRequest: false,
      }),
    ).rejects.toThrow('candidate PR branch identity differs');
    expect(world.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong numeric provider identity', (status: any) => (status.creator.id = 12)],
    ['copied login with user type', (status: any) => (status.creator.type = 'User')],
    ['unexpected context', (status: any) => (status.context = 'Vercel – Web')],
    [
      'wrong Vercel deployment ID',
      (status: any) => (status.target_url = 'https://vercel.com/dayopt/product/other'),
    ],
    [
      'Vercel alias',
      (status: any) => (status.target_url = 'https://product-abc123-dayopt.vercel.app'),
    ],
    [
      'foreign target host',
      (status: any) => (status.target_url = 'https://evil.example/dayopt/product/abc123XYZ'),
    ],
    [
      'target URL userinfo',
      (status: any) =>
        (status.target_url = 'https://vercel.com@evil.example/dayopt/product/abc123XYZ'),
    ],
    [
      'target URL query',
      (status: any) => (status.target_url = 'https://vercel.com/dayopt/product/abc123XYZ?next=x'),
    ],
  ])(
    'rejects an untrusted or unrelated latest Product commit status (%s)',
    async (_name, change) => {
      const world = fixture();
      change(world.state.commitStatuses[0]);
      await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow();
      expect(world.fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects a newer pending status instead of falling back to an older success', async () => {
    const world = fixture();
    world.state.commitStatuses.unshift({
      ...world.state.commitStatuses[0],
      id: 106,
      state: 'pending',
      created_at: '2026-09-29T00:00:06.000Z',
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'latest Product commit status',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong SHA', (deployment: any) => (deployment.sha = 'b'.repeat(40))],
    ['branch ref instead of exact SHA', (deployment: any) => (deployment.ref = branchName)],
    ['wrong environment', (deployment: any) => (deployment.environment = 'Preview')],
    [
      'wrong original environment',
      (deployment: any) => (deployment.original_environment = 'Preview'),
    ],
    ['production environment', (deployment: any) => (deployment.production_environment = true)],
    ['missing production guard', (deployment: any) => delete deployment.production_environment],
    ['wrong task', (deployment: any) => (deployment.task = 'deploy:production')],
    [
      'wrong repository URL',
      (deployment: any) => (deployment.repository_url = 'https://api.github.com/repos/other/repo'),
    ],
    ['wrong numeric creator ID', (deployment: any) => (deployment.creator.id = 12)],
  ])(
    'rejects a deployment outside the exact Product Preview contract (%s)',
    async (_name, change) => {
      const world = fixture();
      change(world.state.deployments[0]);
      await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow();
      expect(world.fetchImpl).toHaveBeenCalledTimes(3);
    },
  );

  it('rejects a newer production deployment record instead of reusing historical Preview success', async () => {
    const world = fixture();
    world.state.deployments.unshift({
      ...world.state.deployments[0],
      id: 802,
      created_at: '2026-09-29T00:00:06.000Z',
      production_environment: true,
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'nonproduction Product deployment',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects same-time deployments because the current provider association is ambiguous', async () => {
    const world = fixture();
    world.state.deployments.push({
      ...world.state.deployments[0],
      id: 802,
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'Product deployment is ambiguous',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('allows an older deployment outside the association window while selecting the current one', async () => {
    const world = fixture();
    world.state.deployments.push({
      ...world.state.deployments[0],
      id: 800,
      created_at: '2026-09-28T23:50:00.000Z',
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).resolves.toMatchObject({
      providerEvidence: { githubDeploymentId },
    });
  });

  it('rejects a second same-SHA deployment close enough to make the Vercel status join ambiguous', async () => {
    const world = fixture();
    world.state.deployments[0].created_at = '2026-09-29T00:00:04.000Z';
    world.state.deployments.push({
      ...world.state.deployments[0],
      id: 800,
      created_at: '2026-09-29T00:00:02.000Z',
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'association is ambiguous',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'newer pending status',
      (statuses: any[]) =>
        statuses.unshift({
          ...statuses[0],
          id: 206,
          state: 'pending',
          created_at: '2026-09-29T00:00:06.000Z',
        }),
    ],
    [
      'newer failure status',
      (statuses: any[]) =>
        statuses.unshift({
          ...statuses[0],
          id: 206,
          state: 'failure',
          created_at: '2026-09-29T00:00:06.000Z',
        }),
    ],
    ['wrong status environment', (statuses: any[]) => (statuses[0].environment = 'Production')],
    ['wrong status creator', (statuses: any[]) => (statuses[0].creator.id = 99)],
    [
      'wrong deployment binding',
      (statuses: any[]) => (statuses[0].deployment_url = `${repositoryUrl}/deployments/802`),
    ],
  ])('rejects an invalid latest deployment status (%s)', async (_name, change) => {
    const world = fixture();
    change(world.state.deploymentStatuses);
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow();
    expect(world.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    'https://product-abc123.vercel.app',
    'http://product-abc123-dayopt.vercel.app',
    'https://user@product-abc123-dayopt.vercel.app',
    'https://product-abc123-dayopt.vercel.app/path',
    'https://product-abc123-dayopt.vercel.app/?next=x',
    'https://product-abc123-dayopt.vercel.app:443',
  ])('rejects noncanonical immutable Preview origin %s', async (environmentUrl) => {
    const world = fixture();
    world.state.deploymentStatuses[0].environment_url = environmentUrl;
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'immutable Product Preview host',
    );
  });

  it('rejects provider records whose completion times cannot be joined within five minutes', async () => {
    const world = fixture();
    world.state.deploymentStatuses[0].created_at = '2026-09-29T00:10:00.000Z';
    await expect(
      observeProductPreviewDeployment({
        ...options(world.fetchImpl),
        now: () => new Date('2026-09-29T00:11:00.000Z'),
      }),
    ).rejects.toThrow('uniquely associated');
  });

  it('rejects malformed and future provider timestamps', async () => {
    const malformed = fixture();
    malformed.state.commitStatuses[0].created_at = '2026-02-30T00:00:05Z';
    await expect(observeProductPreviewDeployment(options(malformed.fetchImpl))).rejects.toThrow(
      'provider timestamp',
    );
    const future = fixture();
    future.state.commitStatuses[0].created_at = '2026-09-29T00:02:00.000Z';
    await expect(observeProductPreviewDeployment(options(future.fetchImpl))).rejects.toThrow(
      'provider timestamp',
    );
  });

  it('rejects redirects and oversized GitHub API bodies without reflecting response content', async () => {
    const redirectWorld = fixture({
      fetchOverride: async () => {
        const response = Response.json({ secret: githubToken });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      },
    });
    await expect(observeProductPreviewDeployment(options(redirectWorld.fetchImpl))).rejects.toThrow(
      'GitHub observation failed',
    );
    const oversizedWorld = fixture({
      fetchOverride: async () =>
        new Response('private-response-body', {
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
    });
    await expect(
      observeProductPreviewDeployment(options(oversizedWorld.fetchImpl)),
    ).rejects.toThrow('GitHub response is too large');
    const reflected = await observeProductPreviewDeployment(options(redirectWorld.fetchImpl)).catch(
      (error: unknown) => error,
    );
    expect(String(reflected)).not.toContain(githubToken);
  });

  it('rejects incomplete pagination rather than trusting a bounded prefix', async () => {
    const world = fixture({
      fetchOverride: async (url: URL) => {
        if (url.pathname === `/repos/Dayopt/dayopt/pulls/${prNumber}`) {
          return Response.json({
            number: prNumber,
            state: 'open',
            draft: false,
            head: {
              ref: branchName,
              sha,
              repo: { id: 1006944000, full_name: 'Dayopt/dayopt', fork: false },
            },
            base: { ref: 'main', repo: { id: 1006944000, full_name: 'Dayopt/dayopt' } },
          });
        }
        if (url.pathname === `/repos/Dayopt/dayopt/commits/${sha}/statuses`) {
          return new Response('[]', {
            headers: { link: '<https://api.github.com/next?page=2>; rel="next"' },
          });
        }
        throw new Error('unexpected endpoint');
      },
    });
    await expect(observeProductPreviewDeployment(options(world.fetchImpl))).rejects.toThrow(
      'commit status pagination limit exceeded',
    );
    expect(world.fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('rejects invalid request identity before sending credentials', async () => {
    const world = fixture();
    await expect(
      observeProductPreviewDeployment({
        ...options(world.fetchImpl),
        deploymentId: 'dpl_bad/path',
      }),
    ).rejects.toThrow('invalid candidate SHA or deployment ID');
    await expect(
      observeProductPreviewDeployment({
        ...options(world.fetchImpl),
        githubToken: 'token with spaces',
      }),
    ).rejects.toThrow('GitHub read credential is required');
    expect(world.fetchImpl).not.toHaveBeenCalled();
  });
});
