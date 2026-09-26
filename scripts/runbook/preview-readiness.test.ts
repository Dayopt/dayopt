import { describe, expect, it, vi } from 'vitest';

import { observePreviewReadiness, parsePreviewReadinessArgs } from './preview-readiness.mjs';

const options = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test123',
  branchName: 'codex/test',
  prNumber: 2910,
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  supabaseBranchId: '11111111-1111-1111-1111-111111111111',
  databaseMode: 'ephemeral',
  expectedMigrations: ['20260901000000'],
  vercelToken: 'vercel-private',
  supabaseToken: 'supabase-private',
  bypassSecret: 'bypass-private',
};

function world() {
  const deployment = {
    id: options.deploymentId,
    projectId: 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa',
    target: null as string | null,
    readyState: 'READY',
    url: 'product-abc123-dayopt.vercel.app',
    meta: {
      githubCommitSha: options.sha,
      githubCommitRef: options.branchName,
      githubCommitOrg: 'Dayopt',
      githubCommitRepo: 'dayopt',
    },
  };
  const branch = {
    id: options.supabaseBranchId,
    project_ref: options.supabaseProjectRef,
    parent_project_ref: 'yvglwblxrnrenfifsnje',
    is_default: false,
    with_data: false,
    persistent: false,
    status: 'FUNCTIONS_DEPLOYED',
    git_branch: options.branchName,
    pr_number: options.prNumber,
  };
  const version = {
    preview: {
      deploymentId: options.deploymentId,
      sha: options.sha,
      supabaseProjectRef: options.supabaseProjectRef,
    },
  };
  const health = { status: 'healthy', environment: 'preview', checks: { database: 'ok' } };
  const migrations = [{ version: '20260901000000' }];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(init?.redirect).toBe('error');
    if (url.startsWith('https://api.vercel.com/')) return Response.json(deployment);
    if (url.endsWith('/branches')) return Response.json([branch]);
    if (url.endsWith('/database/query')) {
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
        read_only: true,
      });
      return Response.json(migrations);
    }
    if (url.endsWith('/api/health/version')) return Response.json(version);
    if (url.endsWith('/api/health')) return Response.json(health);
    throw new Error('unexpected request');
  });
  return { deployment, branch, version, health, migrations, fetchImpl };
}

describe('Preview readiness', () => {
  it('指定候補と同じdeployment/branch/migrations/appを確認して公開証拠だけ返す', async () => {
    const w = world();
    const result = await observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl });
    expect(result).toMatchObject({
      status: 'ready',
      sha: options.sha,
      supabaseProjectRef: options.supabaseProjectRef,
      origin: 'https://product-abc123-dayopt.vercel.app',
    });
    expect(w.fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toContain('private');
    for (const [input, init] of w.fetchImpl.mock.calls) {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(
        url.startsWith('https://api.vercel.com/')
          ? 'Bearer vercel-private'
          : url.startsWith('https://api.supabase.com/')
            ? 'Bearer supabase-private'
            : null,
      );
      expect(headers.get('x-vercel-protection-bypass')).toBe(
        url.startsWith('https://product-') ? 'bypass-private' : null,
      );
    }
  });

  it('shared DBは指定したpersistentだけを使用する', async () => {
    const w = world();
    w.branch.persistent = true;
    w.branch.git_branch = 'integration';
    w.branch.pr_number = 0;
    await expect(
      observePreviewReadiness({ ...options, databaseMode: 'shared', fetchImpl: w.fetchImpl }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it.each(['projectId', 'readyState', 'url'] as const)(
    '不正deployment %sを拒否しDBへ進まない',
    async (key) => {
      const w = world();
      w.deployment[key] = 'wrong';
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'deployment',
      );
      expect(w.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('本番deploymentを拒否', async () => {
    const w = world();
    w.deployment.target = 'production';
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'deployment',
    );
  });

  it.each(['githubCommitSha', 'githubCommitRef', 'githubCommitOrg', 'githubCommitRepo'] as const)(
    '別Git source %sを拒否',
    async (key) => {
      const w = world();
      w.deployment.meta[key] = 'wrong';
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'deployment',
      );
    },
  );

  it.each(['is_default', 'with_data', 'persistent'] as const)(
    '不正branch %sを拒否',
    async (key) => {
      const w = world();
      w.branch[key] = true;
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'branch',
      );
      expect(w.fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['id', 'project_ref', 'parent_project_ref', 'git_branch', 'status'] as const)(
    '誤ったbranch %sを拒否',
    async (key) => {
      const w = world();
      w.branch[key] = 'wrong';
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'branch',
      );
    },
  );

  it('別PRのephemeral DBを拒否', async () => {
    const w = world();
    w.branch.pr_number = 1;
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'branch',
    );
  });

  it.each(['missing', 'extra'])('migration %sを拒否', async (mode) => {
    const w = world();
    if (mode === 'missing') w.migrations.pop();
    else w.migrations.push({ version: '20260902000000' });
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'migration sets differ',
    );
  });

  it.each(['sha', 'supabaseProjectRef', 'deploymentId'] as const)(
    'アプリが報告した別%sを拒否',
    async (key) => {
      const w = world();
      w.version.preview[key] = 'wrong';
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'application',
      );
    },
  );

  it('DB疎通のwarningを合格にしない', async () => {
    const w = world();
    w.health.checks.database = 'warning';
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'health',
    );
  });

  it('本番DBと欠落credentialはネットワーク前に止める', async () => {
    const w = world();
    await expect(
      observePreviewReadiness({
        ...options,
        supabaseProjectRef: 'yvglwblxrnrenfifsnje',
        fetchImpl: w.fetchImpl,
      }),
    ).rejects.toThrow('nonproduction');
    await expect(
      observePreviewReadiness({ ...options, vercelToken: '', fetchImpl: w.fetchImpl }),
    ).rejects.toThrow('credentials');
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['http', 'json', 'network'])(
    '観測失敗%sの生応答やsecretを診断へ出さない',
    async (mode) => {
      const fetchImpl = vi.fn(async () => {
        if (mode === 'network') throw new Error('vercel-private');
        return new Response('vercel-private', { status: mode === 'http' ? 403 : 200 });
      });
      await expect(observePreviewReadiness({ ...options, fetchImpl })).rejects.toThrow(
        /^Preview readiness: platform observation failed$/,
      );
    },
  );
});

describe('Preview readiness CLI input', () => {
  const argv = [
    '--sha',
    options.sha,
    '--deployment',
    options.deploymentId,
    '--branch',
    options.branchName,
    '--pr',
    '2910',
    '--db-ref',
    options.supabaseProjectRef,
    '--db-branch',
    options.supabaseBranchId,
    '--db-mode',
    'ephemeral',
  ];
  it('候補の識別子を明示する', () => {
    expect(parsePreviewReadinessArgs(argv)).toEqual({
      sha: options.sha,
      deploymentId: options.deploymentId,
      branchName: options.branchName,
      prNumber: 2910,
      supabaseProjectRef: options.supabaseProjectRef,
      supabaseBranchId: options.supabaseBranchId,
      databaseMode: 'ephemeral',
    });
  });
  it.each([[], ['--token', 'secret'], [...argv, '--sha', options.sha], argv.slice(0, -1)])(
    '不足/secret/重複引数を拒否',
    (args) => {
      expect(() => parsePreviewReadinessArgs(args)).toThrow();
    },
  );
});
