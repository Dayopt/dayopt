import { describe, expect, it, vi } from 'vitest';

import {
  observePreviewCleanupReadiness,
  observePreviewReadiness,
  parsePreviewReadinessArgs,
} from './preview-readiness.mjs';

const options = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test123',
  branchName: 'codex/test',
  prNumber: 2910,
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  supabaseBranchId: '11111111-1111-1111-1111-111111111111',
  databaseMode: 'ephemeral',
  expectedMigrations: ['20260901000000'],
  githubToken: 'github-private',
  supabaseToken: 'supabase-private',
  bypassSecret: 'bypass-private',
};

function world() {
  const creator = { id: 35613825, login: 'vercel[bot]', type: 'Bot' };
  const createdAt = '2026-09-28T11:23:45Z';
  const pr = {
    number: options.prNumber,
    state: 'open',
    draft: false,
    head: {
      ref: options.branchName,
      sha: options.sha,
      repo: { id: 1006944000, full_name: 'Dayopt/dayopt', fork: false },
    },
    base: { ref: 'main', repo: { id: 1006944000, full_name: 'Dayopt/dayopt' } },
  };
  const commitStatus = {
    id: 55073316235,
    state: 'success',
    context: 'Vercel – product',
    target_url: `https://vercel.com/dayopt/product/${options.deploymentId.slice(4)}`,
    created_at: createdAt,
    creator,
  };
  const deployment = {
    id: 6708659866,
    sha: options.sha,
    ref: options.sha,
    task: 'deploy',
    environment: 'Preview – product',
    original_environment: 'Preview – product',
    production_environment: false,
    repository_url: 'https://api.github.com/repos/Dayopt/dayopt',
    created_at: createdAt,
    creator,
  };
  const deploymentStatus = {
    id: 18941762944,
    state: 'success',
    environment: 'Preview – product',
    environment_url: 'https://product-abc123-dayopt.vercel.app',
    deployment_url: `https://api.github.com/repos/Dayopt/dayopt/deployments/${deployment.id}`,
    repository_url: 'https://api.github.com/repos/Dayopt/dayopt',
    created_at: createdAt,
    creator,
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
    if (url.startsWith('https://api.github.com/')) {
      const path = new URL(url).pathname;
      if (path.endsWith(`/pulls/${options.prNumber}`)) return Response.json(pr);
      if (path.endsWith(`/git/commits/${'c'.repeat(40)}`)) {
        return Response.json({
          sha: 'c'.repeat(40),
          parents: [{ sha: 'b'.repeat(40) }, { sha: options.sha }],
        });
      }
      if (path.endsWith(`/compare/${'c'.repeat(40)}...${'d'.repeat(40)}`)) {
        return Response.json({
          status: 'ahead',
          ahead_by: 1,
          behind_by: 0,
          merge_base_commit: { sha: 'c'.repeat(40) },
        });
      }
      if (path.endsWith(`/commits/${options.sha}/statuses`)) return Response.json([commitStatus]);
      if (path.endsWith(`/deployments/${deployment.id}/statuses`))
        return Response.json([deploymentStatus]);
      if (path.endsWith('/deployments')) return Response.json([deployment]);
    }
    if (url.endsWith('/branches')) return Response.json([branch]);
    if (url.endsWith('/database/migrations')) {
      expect(url).toBe(
        `https://api.supabase.com/v1/projects/${options.supabaseProjectRef}/database/migrations`,
      );
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('Content-Type')).toBeNull();
      return Response.json(migrations);
    }
    if (url.endsWith('/api/health/version')) return Response.json(version);
    if (url.endsWith('/api/health')) return Response.json(health);
    throw new Error('unexpected request');
  });
  return {
    pr,
    commitStatus,
    deployment,
    deploymentStatus,
    branch,
    version,
    health,
    migrations,
    fetchImpl,
  };
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
    expect(w.fetchImpl).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.providerEvidence).toMatchObject({
      provider: 'vercel',
      githubDeploymentId: w.deployment.id,
      githubDeploymentStatusId: w.deploymentStatus.id,
      githubCommitStatusId: w.commitStatus.id,
    });
    for (const [input, init] of w.fetchImpl.mock.calls) {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(
        url.startsWith('https://api.github.com/')
          ? 'Bearer github-private'
          : url.startsWith('https://api.supabase.com/')
            ? 'Bearer supabase-private'
            : null,
      );
      expect(headers.get('x-vercel-protection-bypass')).toBe(
        url.startsWith('https://product-') ? 'bypass-private' : null,
      );
    }
  });
  it('merged policy keeps the exact merge binding through the readiness result', async () => {
    const w = world();
    const mergeCommitSha = 'c'.repeat(40);
    Object.assign(w.pr, {
      state: 'closed',
      merged: true,
      merge_commit_sha: mergeCommitSha,
    });
    w.pr.base.ref = 'integration';
    const result = await observePreviewReadiness({
      ...options,
      mergedValidation: true,
      mergeCommitSha,
      workflowSha: 'd'.repeat(40),
      fetchImpl: w.fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'ready',
      mergedValidation: true,
      mergeCommitSha,
    });
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

  it('通常のreadinessはclose/head更新済みPRをcleanup policyで受け入れない', async () => {
    const w = world();
    w.pr.state = 'closed';
    w.pr.draft = true;
    w.pr.head.sha = 'b'.repeat(40);
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'candidate PR is not open and ready',
    );
    await expect(
      observePreviewReadiness({
        ...options,
        fetchImpl: w.fetchImpl,
        // Deliberately bypass the static union to verify runtime input rejection.
        pullRequestPolicy: 'cleanup' as never,
      }),
    ).rejects.toThrow('candidate PR policy is invalid');
  });

  it.each(['deployment', 'database', 'migrations'])(
    'cleanup専用readinessも固定%sの不一致を拒否する',
    async (mismatch) => {
      const w = world();
      w.pr.state = 'closed';
      w.pr.draft = true;
      w.pr.head.sha = 'b'.repeat(40);
      if (mismatch === 'deployment') w.version.preview.sha = 'b'.repeat(40);
      if (mismatch === 'database') w.branch.project_ref = 'b'.repeat(20);
      if (mismatch === 'migrations') w.migrations[0].version = '20260902000000';
      await expect(
        observePreviewCleanupReadiness({ ...options, fetchImpl: w.fetchImpl }),
      ).rejects.toThrow(
        mismatch === 'deployment'
          ? 'application deployment or database identity differs'
          : mismatch === 'database'
            ? 'database branch is not the requested ready nonproduction environment'
            : 'migration sets differ',
      );
    },
  );

  it.each([60_001, -1])(
    '全provider/DB/app観測の時間差%smsが古い/逆行した場合は合格にしない',
    async (elapsed) => {
      const w = world();
      const started = Date.parse('2026-09-29T00:00:00Z');
      let clock = started;
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const response = await w.fetchImpl(input, init);
        if (String(input).endsWith('/api/health')) clock = started + elapsed;
        return response;
      });
      await expect(
        observePreviewReadiness({ ...options, fetchImpl, now: () => new Date(clock) }),
      ).rejects.toThrow('observation window is stale or clock moved backwards');
      expect(fetchImpl).toHaveBeenCalledTimes(8);
    },
  );

  it('全観測60秒ちょうどは許可し開始/終了時刻を残す', async () => {
    const w = world();
    const started = Date.parse('2026-09-29T00:00:00Z');
    let clock = started;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await w.fetchImpl(input, init);
      if (String(input).endsWith('/api/health')) clock = started + 60_000;
      return response;
    });
    await expect(
      observePreviewReadiness({ ...options, fetchImpl, now: () => new Date(clock) }),
    ).resolves.toMatchObject({
      startedAt: '2026-09-29T00:00:00.000Z',
      observedAt: '2026-09-29T00:01:00.000Z',
    });
  });

  it('不正な観測clockはネットワーク前に停止する', async () => {
    const w = world();
    await expect(
      observePreviewReadiness({
        ...options,
        fetchImpl: w.fetchImpl,
        now: () => new Date('invalid'),
      }),
    ).rejects.toThrow('observation clock is invalid');
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['sha', 'task', 'environment'] as const)(
    'GitHub provider deploymentの不正%sを拒否しDBへ進まない',
    async (key) => {
      const w = world();
      w.deployment[key] = 'wrong';
      await expect(
        observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl }),
      ).rejects.toThrow();
      expect(
        w.fetchImpl.mock.calls.some(([input]) => String(input).includes('api.supabase.com')),
      ).toBe(false);
    },
  );

  it('GitHub providerが示した本番deploymentを拒否', async () => {
    const w = world();
    w.deployment.production_environment = true;
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow();
  });

  it.each(['sha', 'ref'] as const)('別PR source %sを拒否', async (key) => {
    const w = world();
    w.pr.head[key] = 'wrong';
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow();
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['is_default', 'with_data', 'persistent'] as const)(
    '不正branch %sを拒否',
    async (key) => {
      const w = world();
      w.branch[key] = true;
      await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
        'branch',
      );
      expect(w.fetchImpl).toHaveBeenCalledTimes(5);
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

  it('migration metadataのnameと順序に依存せずversion集合を厳密照合する', async () => {
    const w = world();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/database/migrations')
        ? Response.json([
            { version: '20260902000000', name: 'second' },
            { version: '20260901000000', name: 'first' },
          ])
        : w.fetchImpl(input, init),
    );
    await expect(
      observePreviewReadiness({
        ...options,
        expectedMigrations: ['20260901000000', '20260902000000'],
        fetchImpl,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it.each([
    null,
    { migrations: [{ version: '20260901000000' }] },
    [null],
    [{ version: 20260901000000 }],
    [{ version: 'invalid' }],
    [{ name: 'no-version' }],
  ])('不正なmigration metadataを拒否しアプリへ進まない: %j', async (migrations) => {
    const w = world();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/database/migrations')
        ? Response.json(migrations)
        : w.fetchImpl(input, init),
    );
    await expect(observePreviewReadiness({ ...options, fetchImpl })).rejects.toThrow(
      'migration observation is invalid',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('重複したmigration versionは集合へ丸めず拒否する', async () => {
    const w = world();
    w.migrations.push({ version: '20260901000000' });
    await expect(observePreviewReadiness({ ...options, fetchImpl: w.fetchImpl })).rejects.toThrow(
      'migration sets differ',
    );
  });

  it('Migrations Readの権限不足でSQLへfallbackしない', async () => {
    const w = world();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/database/migrations')
        ? new Response('supabase-private', { status: 403 })
        : w.fetchImpl(input, init),
    );
    await expect(observePreviewReadiness({ ...options, fetchImpl })).rejects.toThrow(
      /^Preview readiness: platform observation failed$/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/database/query'))).toBe(
      false,
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
      observePreviewReadiness({ ...options, githubToken: '', fetchImpl: w.fetchImpl }),
    ).rejects.toThrow('credentials');
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['http', 'json', 'network'])(
    '観測失敗%sの生応答やsecretを診断へ出さない',
    async (mode) => {
      const w = world();
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).startsWith('https://api.supabase.com/')) return w.fetchImpl(input, init);
        if (mode === 'network') throw new Error('supabase-private');
        return new Response('supabase-private', { status: mode === 'http' ? 403 : 200 });
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
