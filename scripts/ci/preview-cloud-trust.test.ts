import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  validateRunnerOutputPath,
  verifyPreviewCloudTrust,
  writeValidatedPreviewCloudRequest,
} from './preview-cloud-trust.mjs';

const persistentRef = 'tilwaprottpyhlfoggbb';
const persistentBranchId = '4c2ed092-cba3-4f37-98e1-78f61cdf52ed';
const productionRef = 'yvglwblxrnrenfifsnje';
const sha = 'a'.repeat(40);

const context = {
  eventName: 'workflow_dispatch',
  repository: 'Dayopt/dayopt',
  ref: 'refs/heads/main',
  token: 'read-only-token',
  requestJson: JSON.stringify({
    preview_e2e: true,
    preview_pr: '2910',
    preview_sha: sha,
    preview_deployment: 'dpl_abc123XYZ',
    preview_db_ref: persistentRef,
    preview_db_branch: persistentBranchId,
    preview_db_mode: 'shared',
    preview_recover_run: '',
    preview_recover_attempt: '',
  }),
};

type GithubFile = { filename: string; previous_filename?: string; status?: string };
type GithubWorldOptions = {
  pr?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  branchPolicies?: Record<string, unknown>;
  filesByPage?: Record<number, GithubFile[]>;
};

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 2910,
    state: 'open',
    draft: false,
    head: {
      sha,
      ref: 'codex/cloud-preview-test-2910',
      repo: { full_name: 'Dayopt/dayopt', fork: false },
    },
    base: {
      ref: 'integration',
      repo: { full_name: 'Dayopt/dayopt' },
    },
    ...overrides,
  };
}

function githubWorld({
  pr = pullRequest(),
  environment = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  },
  branchPolicies = {
    total_count: 1,
    branch_policies: [{ name: 'main', type: 'branch' }],
  },
  filesByPage = { 1: [{ filename: 'apps/product/src/example.ts', status: 'modified' }] },
}: GithubWorldOptions = {}) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer read-only-token');
    if (url.pathname === '/repos/Dayopt/dayopt/environments/Preview%20%E2%80%93%20product') {
      return Response.json(environment);
    }
    if (
      url.pathname ===
      '/repos/Dayopt/dayopt/environments/Preview%20%E2%80%93%20product/deployment-branch-policies'
    ) {
      return Response.json(branchPolicies);
    }
    if (url.pathname === '/repos/Dayopt/dayopt/pulls/2910') return Response.json(pr);
    if (url.pathname === '/repos/Dayopt/dayopt/pulls/2910/files') {
      expect(url.searchParams.get('per_page')).toBe('100');
      const page = Number(url.searchParams.get('page'));
      const files = filesByPage[page] ?? [];
      const maxPage = Math.max(0, ...Object.keys(filesByPage).map(Number));
      const hasNext = page < 30 && (files.length === 100 || page < maxPage);
      return Response.json(files, {
        headers: hasNext
          ? { Link: `<https://api.github.com/next?page=${page + 1}>; rel="next"` }
          : {},
      });
    }
    throw new Error('unexpected GitHub endpoint');
  });
  return { fetchImpl };
}

describe('Preview Cloud trust gate', () => {
  it('accepts only a main-ref dispatch, pinned internal open PR, restricted environment, and shared DB identity', async () => {
    const { fetchImpl } = githubWorld();

    const result = await verifyPreviewCloudTrust({ ...context, fetchImpl });
    expect(result).toEqual({
      prNumber: 2910,
      sha,
      deploymentId: 'dpl_abc123XYZ',
      branchName: 'codex/cloud-preview-test-2910',
      supabaseProjectRef: persistentRef,
      supabaseBranchId: persistentBranchId,
      databaseMode: 'shared',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toContain('read-only-token');
  });

  it.each([
    [
      'both empty recovery fields as in the manual UI',
      ['preview_recover_run', 'preview_recover_attempt'],
    ],
    ['only recovery run', ['preview_recover_run']],
    ['only recovery attempt', ['preview_recover_attempt']],
  ])('accepts omitted %s without weakening the trust checks', async (_label, omitted) => {
    const { fetchImpl } = githubWorld();
    const inputs = JSON.parse(context.requestJson);
    for (const key of omitted) delete inputs[key];
    expect(Object.keys(inputs)).toHaveLength(9 - omitted.length);
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).resolves.toEqual({
      prNumber: 2910,
      sha,
      deploymentId: 'dpl_abc123XYZ',
      branchName: 'codex/cloud-preview-test-2910',
      supabaseProjectRef: persistentRef,
      supabaseBranchId: persistentBranchId,
      databaseMode: 'shared',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it.each([
    'preview_e2e',
    'preview_pr',
    'preview_sha',
    'preview_deployment',
    'preview_db_ref',
    'preview_db_branch',
    'preview_db_mode',
  ])('rejects omitted required field %s before API access', async (key) => {
    const { fetchImpl } = githubWorld();
    const inputs = JSON.parse(context.requestJson);
    delete inputs.preview_recover_run;
    delete inputs.preview_recover_attempt;
    delete inputs[key];
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).rejects.toThrow('unexpected workflow input fields');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(
    ['preview_recover_run', 'preview_recover_attempt'].flatMap((key) =>
      [null, 0, false, '123', ' ', [], {}].map((value) => ({ key, value })),
    ),
  )('rejects explicit recovery input $key=$value before API access', async ({ key, value }) => {
    const { fetchImpl } = githubWorld();
    const inputs = JSON.parse(context.requestJson);
    delete inputs.preview_recover_run;
    delete inputs.preview_recover_attempt;
    inputs[key] = value;
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).rejects.toThrow('recovery inputs cannot be used for Preview E2E');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unknown fields in the seven-field manual UI request before API access', async () => {
    const { fetchImpl } = githubWorld();
    const inputs = JSON.parse(context.requestJson);
    delete inputs.preview_recover_run;
    delete inputs.preview_recover_attempt;
    inputs.preview_unknown = '';
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).rejects.toThrow('unexpected workflow input fields');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong event', { eventName: 'pull_request' }],
    ['wrong repository', { repository: 'attacker/repo' }],
    ['wrong ref', { ref: 'refs/heads/integration' }],
    ['missing token', { token: '' }],
  ])('rejects %s before making API calls', async (_label, override) => {
    const { fetchImpl } = githubWorld();
    await expect(verifyPreviewCloudTrust({ ...context, ...override, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled runner input', { preview_e2e: false }],
    ['non-empty recovery run input', { preview_recover_run: '123' }],
    ['non-empty recovery attempt input', { preview_recover_attempt: '1' }],
    ['invalid PR number', { preview_pr: '0' }],
    ['invalid commit SHA', { preview_sha: 'short' }],
    ['invalid deployment id', { preview_deployment: 'https://example.com' }],
    ['invalid DB mode', { preview_db_mode: 'production' }],
  ])('rejects %s before making API calls', async (_label, inputOverride) => {
    const { fetchImpl } = githubWorld();
    const inputs = JSON.parse(context.requestJson);
    await expect(
      verifyPreviewCloudTrust({
        ...context,
        requestJson: JSON.stringify({ ...inputs, ...inputOverride }),
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not restricted to custom policies',
      {
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
      },
    ],
    [
      'allows protected branches broadly',
      {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: true },
      },
    ],
  ])('rejects an environment that %s before fetching the PR', async (_label, environment) => {
    const { fetchImpl } = githubWorld({ environment });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'includes another branch',
      {
        total_count: 2,
        branch_policies: [
          { name: 'main', type: 'branch' },
          { name: 'integration', type: 'branch' },
        ],
      },
    ],
    [
      'uses a tag policy',
      {
        total_count: 1,
        branch_policies: [{ name: 'main', type: 'tag' }],
      },
    ],
    [
      'has inconsistent total_count',
      {
        total_count: 2,
        branch_policies: [{ name: 'main', type: 'branch' }],
      },
    ],
  ])('rejects a branch-policy response that %s', async (_label, branchPolicies) => {
    const { fetchImpl } = githubWorld({ branchPolicies });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['closed PR', { state: 'closed' }],
    ['draft PR', { draft: true }],
    ['wrong PR number', { number: 1 }],
    ['wrong base branch', { base: { ref: 'release', repo: { full_name: 'Dayopt/dayopt' } } }],
    [
      'external base repository',
      { base: { ref: 'integration', repo: { full_name: 'attacker/dayopt' } } },
    ],
    [
      'fork head repository',
      { head: { sha, ref: 'codex/foo', repo: { full_name: 'Dayopt/dayopt', fork: true } } },
    ],
    [
      'external head repository',
      { head: { sha, ref: 'codex/foo', repo: { full_name: 'attacker/dayopt', fork: true } } },
    ],
    [
      'mismatched SHA',
      {
        head: {
          sha: 'b'.repeat(40),
          ref: 'codex/foo',
          repo: { full_name: 'Dayopt/dayopt', fork: false },
        },
      },
    ],
    [
      'protected source branch',
      { head: { sha, ref: 'main', repo: { full_name: 'Dayopt/dayopt', fork: false } } },
    ],
    [
      'unsafe branch output',
      {
        head: {
          sha,
          ref: 'codex/foo\nsha=other',
          repo: { full_name: 'Dayopt/dayopt', fork: false },
        },
      },
    ],
  ])('rejects a %s', async (_label, prOverride) => {
    const { fetchImpl } = githubWorld({ pr: pullRequest(prOverride) });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects Supabase schema files anywhere in a shared DB PR, including later pages and renames', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `apps/product/src/file-${index}.ts`,
      status: 'modified',
    }));
    const { fetchImpl } = githubWorld({
      filesByPage: {
        1: firstPage,
        2: [{ filename: 'docs/db.md', previous_filename: 'supabase/migrations/old.sql' }],
      },
    });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toThrow();
    const fileCalls = fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes('/pulls/2910/files'),
    );
    expect(fileCalls).toHaveLength(2);
  });

  it('fails closed at the 3,000-file API ceiling instead of trusting a truncated list', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `apps/product/src/file-${index}.ts`,
    }));
    const filesByPage = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [index + 1, fullPage]),
    ) as Record<number, GithubFile[]>;
    const { fetchImpl } = githubWorld({ filesByPage });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toThrow();
    const fileCalls = fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes('/pulls/2910/files'),
    );
    expect(fileCalls).toHaveLength(30);
  });

  it('allows Supabase schema changes only for an ephemeral nonproduction branch', async () => {
    const { fetchImpl } = githubWorld({
      filesByPage: { 1: [{ filename: 'supabase/migrations/20260928000000_test.sql' }] },
    });
    const inputs = {
      ...JSON.parse(context.requestJson),
      preview_db_ref: 'abcdefghijklmnopqrst',
      preview_db_branch: '11111111-1111-4111-8111-111111111111',
      preview_db_mode: 'ephemeral',
    };
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).resolves.toMatchObject({ databaseMode: 'ephemeral' });
  });

  it.each([
    ['production ref', productionRef, '11111111-1111-4111-8111-111111111111'],
    ['persistent shared ref', persistentRef, '11111111-1111-4111-8111-111111111111'],
    ['persistent shared branch id', 'abcdefghijklmnopqrst', persistentBranchId],
  ])('rejects an ephemeral identity using the %s', async (_label, projectRef, branchId) => {
    const { fetchImpl } = githubWorld();
    const inputs = {
      ...JSON.parse(context.requestJson),
      preview_db_ref: projectRef,
      preview_db_branch: branchId,
      preview_db_mode: 'ephemeral',
    };
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects noncanonical shared DB identities before querying GitHub', async () => {
    const { fetchImpl } = githubWorld();
    const inputs = {
      ...JSON.parse(context.requestJson),
      preview_db_branch: '11111111-1111-4111-8111-111111111111',
    };
    await expect(
      verifyPreviewCloudTrust({ ...context, requestJson: JSON.stringify(inputs), fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose API errors or credentials in diagnostics', async () => {
    const fetchImpl = vi.fn(async () => new Response('read-only-token raw-body', { status: 403 }));
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toMatchObject({
      message: 'Preview Cloud trust: GitHub read failed',
    });
    await expect(verifyPreviewCloudTrust({ ...context, fetchImpl })).rejects.toMatchObject({
      message: 'Preview Cloud trust: GitHub read failed',
    });
  });

  it('writes only the validated request and safe scalar workflow outputs', async () => {
    const { fetchImpl } = githubWorld();
    const request = await verifyPreviewCloudTrust({ ...context, fetchImpl });
    const directory = mkdtempSync(join(tmpdir(), 'preview-cloud-trust-'));
    try {
      const requestPath = join(directory, 'preview-request.json');
      const outputPath = join(directory, 'github-output');
      writeValidatedPreviewCloudRequest({ request, requestPath, githubOutputPath: outputPath });
      expect(JSON.parse(readFileSync(requestPath, 'utf8'))).toEqual(request);
      expect(readFileSync(outputPath, 'utf8')).toBe(
        `sha=${sha}\nbranch=codex/cloud-preview-test-2910\n`,
      );
      expect(statSync(requestPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(requestPath, 'utf8')).not.toContain('read-only-token');
      expect(() =>
        writeValidatedPreviewCloudRequest({
          request: { ...request, token: 'unexpected-secret' },
          requestPath: join(directory, 'unsafe-request.json'),
          githubOutputPath: outputPath,
        }),
      ).toThrow('validated request is invalid');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows only the initial and final request files under RUNNER_TEMP', () => {
    const runnerTemp = '/runner/_temp';
    const githubOutputPath = '/runner/_temp/_runner_file_commands/set_output_1';
    expect(() =>
      validateRunnerOutputPath({
        runnerTemp,
        outputPath: `${runnerTemp}/preview-initial-request.json`,
        githubOutputPath,
      }),
    ).not.toThrow();
    expect(() =>
      validateRunnerOutputPath({
        runnerTemp,
        outputPath: `${runnerTemp}/preview-request.json`,
        githubOutputPath,
      }),
    ).not.toThrow();
    expect(() =>
      validateRunnerOutputPath({
        runnerTemp,
        outputPath: `${runnerTemp}/other.json`,
        githubOutputPath,
      }),
    ).toThrow('runner output locations are invalid');
    expect(() =>
      validateRunnerOutputPath({
        runnerTemp,
        outputPath: '/runner/preview-request.json',
        githubOutputPath,
      }),
    ).toThrow('runner output locations are invalid');
  });
});
