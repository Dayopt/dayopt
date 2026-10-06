import { describe, expect, it, vi } from 'vitest';

import {
  INTEGRATION_BRANCH_ID,
  INTEGRATION_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  provisionNonproductionLogin,
  resolveNonproductionLoginCredentials,
} from './nonproduction-login-provision.mjs';

const target = {
  kind: 'preview' as const,
  prNumber: 3024,
  branchName: 'codex/nonprod-login',
  sha: 'a'.repeat(40),
  baseBranch: 'main',
};
const previewBranch = {
  id: '11111111-1111-1111-1111-111111111111',
  project_ref: 'abcdefghijklmnopqrst',
  parent_project_ref: PRODUCTION_PROJECT_REF,
  is_default: false,
  with_data: false,
  persistent: false,
  status: 'FUNCTIONS_DEPLOYED',
  preview_project_status: 'ACTIVE_HEALTHY',
  git_branch: target.branchName,
  pr_number: target.prNumber,
};
const testCredentials = {
  email: 'fixture@example.test',
  password: 'Not-a-real-secret-8372',
  supabaseToken: 'management-token',
};

function buildFetch({
  branch = previewBranch,
  keys = [
    { type: 'secret', api_key: 'branch-secret' },
    { type: 'publishable', api_key: 'branch-publishable' },
  ],
  createResponse = Response.json({ id: 'auth-user' }),
  loginResponse = Response.json({ access_token: 'verification-session', user: { factors: [] } }),
  logoutResponse = new Response(null, { status: 204 }),
  currentPr = {
    number: target.prNumber,
    state: 'open',
    draft: false,
    head: {
      sha: target.sha,
      ref: target.branchName,
      repo: { full_name: 'Dayopt/dayopt', fork: false },
    },
    base: { ref: target.baseBranch, repo: { full_name: 'Dayopt/dayopt' } },
  },
}: {
  branch?: (typeof previewBranch & { pr_number?: number }) | null;
  keys?: Array<{ type?: string; name?: string; api_key: string; disabled?: boolean }>;
  createResponse?: Response;
  loginResponse?: Response;
  logoutResponse?: Response;
  currentPr?: any;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith(`/pulls/${target.prNumber}`)) return Response.json(currentPr);
    if (url.endsWith('/branches')) return Response.json(branch ? [branch] : []);
    if (url.endsWith('/api-keys?reveal=true')) return Response.json(keys);
    if (url.endsWith('/auth/v1/admin/users')) return createResponse;
    if (url.endsWith('/auth/v1/token?grant_type=password')) return loginResponse;
    if (url.endsWith('/auth/v1/logout?scope=local')) return logoutResponse;
    throw new Error('unexpected request');
  });
  return { fetchImpl, calls };
}

describe('nonproduction login provisioning', () => {
  it('uses a different 1Password-backed login for Preview and Integration', () => {
    const env = {
      NONPROD_LOGIN_EMAIL: 'integration@example.test',
      NONPROD_LOGIN_PASSWORD: 'integration-fake-password',
      NONPROD_PREVIEW_LOGIN_EMAIL: 'preview@example.test',
      NONPROD_PREVIEW_LOGIN_PASSWORD: 'preview-fake-password',
    };
    expect(resolveNonproductionLoginCredentials('integration', env)).toEqual({
      email: 'integration@example.test',
      password: 'integration-fake-password',
    });
    expect(resolveNonproductionLoginCredentials('preview', env)).toEqual({
      email: 'preview@example.test',
      password: 'preview-fake-password',
    });
    expect(() => resolveNonproductionLoginCredentials('production', env)).toThrow(
      'target is invalid',
    );
  });
  it('creates and verifies the test account only on the exact ephemeral PR branch', async () => {
    const world = buildFetch();
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => 0,
      }),
    ).resolves.toEqual({
      status: 'created-and-verified',
      target: 'preview',
      projectRef: previewBranch.project_ref,
      branchId: previewBranch.id,
    });

    expect(world.calls.map(({ url }) => new URL(url).pathname)).toEqual([
      `/v1/projects/${PRODUCTION_PROJECT_REF}/branches`,
      `/v1/projects/${previewBranch.project_ref}/api-keys`,
      `/repos/Dayopt/dayopt/pulls/${target.prNumber}`,
      '/auth/v1/admin/users',
      '/auth/v1/token',
      '/auth/v1/logout',
    ]);
    expect(world.calls[1].url).toContain('reveal=true');
    expect(world.calls[3].init?.body).toBe(
      JSON.stringify({
        email: testCredentials.email,
        password: testCredentials.password,
        email_confirm: true,
      }),
    );
    expect(world.calls[4].init?.body).toBe(
      JSON.stringify({ email: testCredentials.email, password: testCredentials.password }),
    );
    expect(new Headers(world.calls[3].init?.headers).get('apikey')).toBe('branch-secret');
    expect(new Headers(world.calls[3].init?.headers).get('Authorization')).toBeNull();
    expect(new Headers(world.calls[4].init?.headers).get('apikey')).toBe('branch-publishable');
    expect(new Headers(world.calls[4].init?.headers).get('Authorization')).toBeNull();
    expect(new Headers(world.calls[5].init?.headers).get('apikey')).toBe('branch-publishable');
    expect(new Headers(world.calls[5].init?.headers).get('Authorization')).toBe(
      'Bearer verification-session',
    );
  });

  it('uses the unique active default for each modern key type during rotation', async () => {
    const world = buildFetch({
      keys: [
        { name: 'service_role', api_key: 'legacy-service-role' },
        { name: 'anon', api_key: 'legacy-anon' },
        ...['secret', 'publishable'].flatMap((type) => [
          { type, name: 'rotation', api_key: `rotation-${type}` },
          { type, name: 'default', api_key: `disabled-${type}`, disabled: true },
          { type, name: 'default', api_key: `default-${type}`, disabled: false },
        ]),
      ],
    });
    await provisionNonproductionLogin({
      target,
      ...testCredentials,
      githubToken: 'github-token',
      fetchImpl: world.fetchImpl,
      now: () => 0,
    });
    const authCalls = world.calls.filter(({ url }) => url.includes('/auth/v1/'));
    expect(authCalls).toHaveLength(3);
    expect(new Headers(authCalls[0].init?.headers).get('apikey')).toBe('default-secret');
    expect(new Headers(authCalls[0].init?.headers).get('Authorization')).toBeNull();
    for (const call of authCalls.slice(1)) {
      expect(new Headers(call.init?.headers).get('apikey')).toBe('default-publishable');
    }
    expect(new Headers(authCalls[1].init?.headers).get('Authorization')).toBeNull();
    expect(new Headers(authCalls[2].init?.headers).get('Authorization')).toBe(
      'Bearer verification-session',
    );
  });

  it.each([
    ['secret', 'default', 'default'],
    ['publishable', 'default', 'default'],
    ['secret', 'rotation-a', 'rotation-b'],
    ['publishable', 'rotation-a', 'rotation-b'],
  ])('rejects ambiguous %s keys (%s / %s) before Auth calls', async (type, first, second) => {
    const world = buildFetch({
      keys: [
        { type: type === 'secret' ? 'publishable' : 'secret', api_key: 'other-key' },
        { type, name: first, api_key: 'first-key' },
        { type, name: second, api_key: 'second-key' },
        { name: 'service_role', api_key: 'legacy-service-role' },
        { name: 'anon', api_key: 'legacy-anon' },
      ],
    });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => 0,
      }),
    ).rejects.toThrow(`branch ${type} API key is unavailable or ambiguous`);
    expect(world.calls.some(({ url }) => url.includes('/auth/v1/'))).toBe(false);
  });

  it('keeps an existing password and closes only the verification session', async () => {
    const world = buildFetch({
      createResponse: Response.json(
        { code: 422, error_code: 'email_exists', msg: 'User already registered' },
        { status: 422 },
      ),
      keys: [
        { name: 'service_role', api_key: 'legacy-service-role' },
        { name: 'anon', api_key: 'legacy-anon' },
      ],
      branch: {
        ...previewBranch,
        id: INTEGRATION_BRANCH_ID,
        project_ref: INTEGRATION_PROJECT_REF,
        persistent: true,
        git_branch: 'integration',
        pr_number: 0,
      },
    });
    const result = await provisionNonproductionLogin({
      target: { kind: 'integration' },
      ...testCredentials,
      fetchImpl: world.fetchImpl,
      now: () => 0,
    });

    expect(result).toMatchObject({
      status: 'existing-credentials-verified',
      target: 'integration',
    });
    expect(new Headers(world.calls[2].init?.headers).get('apikey')).toBe('legacy-service-role');
    expect(new Headers(world.calls[2].init?.headers).get('Authorization')).toBe(
      'Bearer legacy-service-role',
    );
    expect(world.calls[3].url).toContain('grant_type=password');
    expect(new Headers(world.calls[3].init?.headers).get('apikey')).toBe('legacy-service-role');
    expect(new Headers(world.calls[3].init?.headers).get('Authorization')).toBe(
      'Bearer legacy-service-role',
    );
    expect(world.calls[4].url).toContain('scope=local');
    expect(new Headers(world.calls[4].init?.headers).get('Authorization')).toBe(
      'Bearer verification-session',
    );
  });

  it('verifies Integration with its modern admin key while retaining user-token logout', async () => {
    const world = buildFetch({
      branch: {
        ...previewBranch,
        id: INTEGRATION_BRANCH_ID,
        project_ref: INTEGRATION_PROJECT_REF,
        persistent: true,
        git_branch: 'integration',
        pr_number: 0,
      },
      keys: [
        { type: 'secret', api_key: 'sb_secret_SYNTHETIC_ADMIN' },
        { type: 'publishable', api_key: 'sb_publishable_SYNTHETIC_PUBLIC' },
      ],
    });
    await provisionNonproductionLogin({
      target: { kind: 'integration' },
      ...testCredentials,
      fetchImpl: world.fetchImpl,
      now: () => 0,
    });
    const login = world.calls.find(({ url }) =>
      url.endsWith('/auth/v1/token?grant_type=password'),
    )!;
    const logout = world.calls.find(({ url }) => url.endsWith('/auth/v1/logout?scope=local'))!;
    expect(new Headers(login.init?.headers).get('apikey')).toBe('sb_secret_SYNTHETIC_ADMIN');
    expect(new Headers(login.init?.headers).get('Authorization')).toBeNull();
    expect(JSON.parse(String(login.init?.body))).toEqual({
      email: testCredentials.email,
      password: testCredentials.password,
    });
    expect(new Headers(logout.init?.headers).get('apikey')).toBe('sb_publishable_SYNTHETIC_PUBLIC');
    expect(new Headers(logout.init?.headers).get('Authorization')).toBe(
      'Bearer verification-session',
    );
  });

  it('waits for a missing dedicated Preview branch without using Integration', async () => {
    let time = 0;
    const world = buildFetch({ branch: { ...previewBranch, pr_number: 999 } });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => time,
        sleepImpl: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).rejects.toThrow(
      'Nonproduction login: Preview branch not found (pr_number=3024, git_branch=codex/nonprod-login, exact_match_count=0)',
    );
    expect(world.calls.some(({ url }) => url.includes(INTEGRATION_PROJECT_REF))).toBe(false);
    expect(world.calls.some(({ url }) => url.includes('/api-keys?'))).toBe(false);
  });

  it('reports status metadata when the exact Preview branch is still provisioning', async () => {
    let time = 0;
    const world = buildFetch({
      branch: {
        ...previewBranch,
        status: 'RUNNING_MIGRATIONS',
        preview_project_status: 'COMING_UP',
      },
    });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => time,
        sleepImpl: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).rejects.toThrow(
      'Nonproduction login: Preview branch is not ready (pr_number=3024, git_branch=codex/nonprod-login, exact_match_count=1, status=RUNNING_MIGRATIONS, preview_project_status=COMING_UP)',
    );
  });

  it('rejects production before requesting any branch API key', async () => {
    const world = buildFetch({
      branch: {
        ...previewBranch,
        project_ref: PRODUCTION_PROJECT_REF,
        parent_project_ref: PRODUCTION_PROJECT_REF,
        persistent: true,
        is_default: true,
      },
    });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => 0,
      }),
    ).rejects.toThrow('branch is not an isolated nonproduction child');
    expect(world.calls).toHaveLength(1);
  });

  it('does not create or mutate an existing account when the password fails', async () => {
    const world = buildFetch({
      createResponse: Response.json(
        { code: 422, error_code: 'email_exists', msg: 'User already registered' },
        { status: 422 },
      ),
      loginResponse: Response.json({ code: 'invalid_credentials' }, { status: 400 }),
    });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => 0,
      }),
    ).rejects.toThrow('credentials did not authenticate on the target branch');
    expect(world.calls.map(({ url }) => url)).not.toContain(
      `https://${previewBranch.project_ref}.supabase.co/auth/v1/logout?scope=local`,
    );
  });

  it('does not call an enrolled MFA account verified after closing only its local session', async () => {
    const world = buildFetch({
      createResponse: Response.json(
        { code: 422, error_code: 'email_exists', msg: 'User already registered' },
        { status: 422 },
      ),
      loginResponse: Response.json({
        access_token: 'verification-session',
        user: { factors: [{ factor_type: 'totp', status: 'verified' }] },
      }),
    });
    await expect(
      provisionNonproductionLogin({
        target,
        ...testCredentials,
        githubToken: 'github-token',
        fetchImpl: world.fetchImpl,
        now: () => 0,
      }),
    ).rejects.toThrow('MFA enrollment requires interactive verification');
    expect(world.calls.at(-1)?.url).toContain('scope=local');
  });
});
