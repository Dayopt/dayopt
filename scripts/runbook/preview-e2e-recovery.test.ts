import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPreviewRunManifest,
  listPreviewRecoveryRuns,
  previewE2EStateRoot,
  recoverPreviewE2ERun,
  requireTrustedRecoverySource,
  writePreviewRunManifest,
} from './preview-e2e-recovery.mjs';
import { observePreviewCleanupReadiness } from './preview-readiness.mjs';

const runA = '11111111-1111-1111-1111-111111111111';
const runB = '22222222-2222-2222-2222-222222222222';
const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const fixedNow = new Date('2026-09-28T03:00:00.000Z');
const staleHeartbeat = new Date(fixedNow.getTime() - 11 * 60 * 1000).toISOString();
const ready = {
  status: 'ready',
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test123',
  prNumber: 2910,
  branchName: 'codex/test',
  databaseMode: 'shared',
  supabaseBranchId: '33333333-3333-3333-3333-333333333333',
  migrationVersions: ['20260901000000'],
  startedAt: '2026-09-28T02:59:00.000Z',
  observedAt: '2026-09-28T02:59:01.000Z',
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  origin: 'https://product-abc123-dayopt.vercel.app',
};
const env = {
  SUPABASE_PREVIEW_PROVISION_TOKEN: 'nonproduction-provision-token',
  GITHUB_TOKEN: 'github-read-token',
  SUPABASE_PREVIEW_READINESS_TOKEN: 'supabase-read-token',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'preview-bypass',
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'preview-recovery-'));
  roots.push(root);
  return root;
}

function addRun(
  root: string,
  runId: string,
  users: Array<{ userId: string; status?: string }> = [],
) {
  const directory = join(root, runId);
  const evidenceDirectory = join(directory, 'evidence');
  const usersDirectory = join(evidenceDirectory, 'users');
  mkdirSync(usersDirectory, { recursive: true, mode: 0o700 });
  const manifest = {
    ...createPreviewRunManifest({ runId, ready, evidenceDirectory, now: fixedNow }),
    status: 'failed',
    heartbeatAt: staleHeartbeat,
  };
  writePreviewRunManifest(directory, manifest);
  for (const user of users) {
    writeFileSync(
      join(usersDirectory, `${user.userId}.json`),
      JSON.stringify({
        runId,
        userId: user.userId,
        status: user.status ?? 'created',
        observedAt: staleHeartbeat,
      }),
      { mode: 0o600 },
    );
  }
  return { directory, evidenceDirectory };
}

function fakeAdmin(usersById: Map<string, unknown>, failingTable = '', remainingTable = '') {
  const calls: string[] = [];
  const admin = {
    auth: {
      admin: {
        getUserById: vi.fn(async (userId: string) => {
          calls.push(`auth:get:${userId}`);
          const user = usersById.get(userId);
          return user
            ? { data: { user }, error: null }
            : { data: { user: null }, error: { status: 404 } };
        }),
        deleteUser: vi.fn(async (userId: string) => {
          calls.push(`auth:delete:${userId}`);
          usersById.delete(userId);
          return { error: null };
        }),
      },
    },
    from: (table: string) => ({
      delete: () => ({
        eq: async (column: string, userId: string) => {
          calls.push(`${table}:${column}:${userId}`);
          return { error: table === failingTable ? { status: 500 } : null };
        },
      }),
      select: (column: string) => ({
        eq: async (_column: string, userId: string) => {
          calls.push(`verify:${table}:${column}:${userId}`);
          return { count: table === remainingTable ? 1 : 0, error: null };
        },
      }),
    }),
  };
  return { admin, calls };
}

function ownedUser(userId: string, runId: string) {
  return {
    id: userId,
    email: `critical-path-${userId}@example.com`,
    app_metadata: { e2e_run_id: runId },
  };
}

function recovery(root: string, runId: string, admin: unknown, observed = ready) {
  return recoverPreviewE2ERun({
    runId,
    stateRoot: root,
    env,
    observe: vi.fn(async () => observed),
    createAdmin: vi.fn(() => admin),
    resolveServiceKey: vi.fn(async ({ projectRef, provisionToken }) => {
      expect(projectRef).toBe(ready.supabaseProjectRef);
      expect(provisionToken).toBe(env.SUPABASE_PREVIEW_PROVISION_TOKEN);
      return 'sb_secret_preview-test';
    }),
    now: () => fixedNow,
  });
}

describe('Preview E2E interrupted-run recovery', () => {
  it('stores private, stable run evidence without passwords or service credentials', () => {
    const root = workspace();
    const { directory, evidenceDirectory } = addRun(root, runA, [{ userId: userA }]);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 1,
      runId: runA,
      status: 'failed',
      evidenceDirectory,
      candidate: {
        sha: ready.sha,
        deploymentId: ready.deploymentId,
        supabaseProjectRef: ready.supabaseProjectRef,
        supabaseBranchId: ready.supabaseBranchId,
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/password|secret|token/i);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'manifest.json')).mode & 0o777).toBe(0o600);
  });

  it('blocks a fresh run and performs no remote access or deletion', async () => {
    const root = workspace();
    const { directory } = addRun(root, runA, [{ userId: userA }]);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.status = 'running';
    manifest.heartbeatAt = fixedNow.toISOString();
    writePreviewRunManifest(directory, manifest);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));
    const observe = vi.fn(async () => ready);
    const createAdmin = vi.fn(() => remoteAdmin.admin);

    await expect(
      recoverPreviewE2ERun({
        runId: runA,
        stateRoot: root,
        env,
        observe,
        createAdmin,
        now: () => fixedNow,
      }),
    ).rejects.toThrow('still active');
    expect(observe).not.toHaveBeenCalled();
    expect(createAdmin).not.toHaveBeenCalled();
    expect(remoteAdmin.calls).toEqual([]);
  });

  it('removes leftover private output when cleanup already completed', async () => {
    const root = workspace();
    const { directory } = addRun(root, runA);
    const privateDirectory = join(directory, 'private');
    mkdirSync(privateDirectory, { mode: 0o700 });
    writeFileSync(join(privateDirectory, 'trace.zip'), 'private output');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    manifest.status = 'recovered';
    writePreviewRunManifest(directory, manifest);
    const remoteAdmin = fakeAdmin(new Map());

    await expect(recovery(root, runA, remoteAdmin.admin)).resolves.toMatchObject({
      status: 'recovered',
    });
    expect(existsSync(privateDirectory)).toBe(false);
    expect(remoteAdmin.calls).toEqual([]);
  });

  it('recovers only manifest users whose Auth ID, app_metadata run and synthetic email match', async () => {
    const root = workspace();
    const { directory, evidenceDirectory } = addRun(root, runA, [{ userId: userA }]);
    writeFileSync(join(evidenceDirectory, 'users', `${userA}.json.tmp`), '{partial', {
      mode: 0o600,
    });
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    manifest.status = 'running';
    writePreviewRunManifest(directory, manifest);
    addRun(root, runB, [{ userId: userB }]);
    const users = new Map([
      [userA, ownedUser(userA, runA)],
      [userB, ownedUser(userB, runB)],
    ]);
    const remoteAdmin = fakeAdmin(users);

    const result = await recovery(root, runA, remoteAdmin.admin);

    expect(result).toEqual({
      runId: runA,
      status: 'recovered',
      recoveredUserIds: [userA],
      evidenceDirectory,
    });
    expect(remoteAdmin.calls).toContain(`auth:delete:${userA}`);
    expect(remoteAdmin.calls).not.toContain(`auth:delete:${userB}`);
    expect(remoteAdmin.calls.every((call) => !call.includes(userB))).toBe(true);
    expect(existsSync(join(evidenceDirectory, 'users', `${userA}.json.tmp`))).toBe(false);
    expect(users.has(userB)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(evidenceDirectory, 'users', `${userA}.json`), 'utf8')),
    ).toMatchObject({ runId: runA, userId: userA, status: 'deleted' });
    expect(JSON.parse(readFileSync(join(root, runA, 'manifest.json'), 'utf8')).status).toBe(
      'recovered',
    );
  });

  it('recovers the separate account-deletion namespace when its run marker matches', async () => {
    const root = workspace();
    const { evidenceDirectory } = addRun(root, runA, [{ userId: userA }]);
    const accountDeletionUser = {
      ...ownedUser(userA, runA),
      email: `account-deletion-${userA}@example.com`,
    };
    const remoteAdmin = fakeAdmin(new Map([[userA, accountDeletionUser]]));

    const result = await recovery(root, runA, remoteAdmin.admin);

    expect(result).toMatchObject({ status: 'recovered', recoveredUserIds: [userA] });
    expect(remoteAdmin.calls).toContain(`auth:delete:${userA}`);
    expect(
      JSON.parse(readFileSync(join(evidenceDirectory, 'users', `${userA}.json`), 'utf8')),
    ).toMatchObject({ runId: runA, userId: userA, status: 'deleted' });
  });

  it('resolves the pinned candidate key after exact readiness before creating the admin client', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA }]);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));
    const resolvedKey = 'sb_secret_preview-test';
    const resolveServiceKey = vi.fn(async () => resolvedKey);
    const createAdmin = vi.fn(() => remoteAdmin.admin);

    await recoverPreviewE2ERun({
      runId: runA,
      stateRoot: root,
      env,
      observe: vi.fn(async () => ready),
      createAdmin,
      resolveServiceKey,
      now: () => fixedNow,
    });

    expect(resolveServiceKey).toHaveBeenCalledOnce();
    expect(resolveServiceKey).toHaveBeenCalledWith({
      projectRef: ready.supabaseProjectRef,
      provisionToken: env.SUPABASE_PREVIEW_PROVISION_TOKEN,
    });
    expect(createAdmin).toHaveBeenCalledWith(ready.supabaseProjectRef, resolvedKey);
  });

  it('rejects database identity changes before constructing an admin client', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA }]);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));

    const resolveServiceKey = vi.fn(async () => 'sb_secret_preview-test');
    await expect(
      recoverPreviewE2ERun({
        runId: runA,
        stateRoot: root,
        env,
        observe: vi.fn(async () => ({ ...ready, supabaseBranchId: runB })),
        createAdmin: vi.fn(() => remoteAdmin.admin),
        resolveServiceKey,
        now: () => fixedNow,
      }),
    ).rejects.toThrow('target does not match');
    expect(resolveServiceKey).not.toHaveBeenCalled();
    expect(remoteAdmin.calls).toEqual([]);
  });

  it('所有runの回収は現在PRの実行可能条件だけを外し固定候補を再照合する', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA }]);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));
    const observe = vi.fn(async () => ready);
    await expect(
      recoverPreviewE2ERun({
        runId: runA,
        stateRoot: root,
        env,
        observe,
        createAdmin: () => remoteAdmin.admin,
        resolveServiceKey: async ({ projectRef, provisionToken }) => {
          expect(projectRef).toBe(ready.supabaseProjectRef);
          expect(provisionToken).toBe(env.SUPABASE_PREVIEW_PROVISION_TOKEN);
          return 'sb_secret_preview-test';
        },
        now: () => fixedNow,
      }),
    ).resolves.toMatchObject({ status: 'recovered', recoveredUserIds: [userA] });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestPolicy: 'cleanup',
        githubToken: 'github-read-token',
        sha: ready.sha,
        deploymentId: ready.deploymentId,
        supabaseProjectRef: ready.supabaseProjectRef,
      }),
    );
  });

  it('実際のcleanup readinessと合成してclose/head更新済みPRの所有ユーザーだけ回収する', async () => {
    const root = workspace();
    const { directory, evidenceDirectory } = addRun(root, runA, [{ userId: userA }]);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    manifest.status = 'running';
    writePreviewRunManifest(directory, manifest);
    addRun(root, runB, [{ userId: userB }]);
    const users = new Map([
      [userA, ownedUser(userA, runA)],
      [userB, ownedUser(userB, runB)],
    ]);
    const remoteAdmin = fakeAdmin(users);
    const creator = { id: 35613825, login: 'vercel[bot]', type: 'Bot' };
    const createdAt = '2026-09-28T02:00:00Z';
    const repository = { id: 1006944000, full_name: 'Dayopt/dayopt', fork: false };
    const repositoryUrl = 'https://api.github.com/repos/Dayopt/dayopt';
    const deploymentId = 6708659866;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.body).toBeUndefined();
      const path = new URL(url).pathname;
      if (path === `/repos/Dayopt/dayopt/pulls/${ready.prNumber}`) {
        return Response.json({
          number: ready.prNumber,
          state: 'closed',
          draft: true,
          head: { ref: ready.branchName, sha: 'b'.repeat(40), repo: repository },
          base: { ref: 'integration', repo: repository },
        });
      }
      if (path === `/repos/Dayopt/dayopt/commits/${ready.sha}/statuses`) {
        return Response.json([
          {
            id: 55073316235,
            state: 'success',
            context: 'Vercel – product',
            target_url: `https://vercel.com/dayopt/product/${ready.deploymentId.slice(4)}`,
            created_at: createdAt,
            creator,
          },
        ]);
      }
      if (path === '/repos/Dayopt/dayopt/deployments') {
        return Response.json([
          {
            id: deploymentId,
            sha: ready.sha,
            ref: ready.sha,
            task: 'deploy',
            environment: 'Preview – product',
            original_environment: 'Preview – product',
            production_environment: false,
            repository_url: repositoryUrl,
            created_at: createdAt,
            creator,
          },
        ]);
      }
      if (path === `/repos/Dayopt/dayopt/deployments/${deploymentId}/statuses`) {
        return Response.json([
          {
            id: 18941762944,
            state: 'success',
            environment: 'Preview – product',
            environment_url: ready.origin,
            deployment_url: `${repositoryUrl}/deployments/${deploymentId}`,
            repository_url: repositoryUrl,
            created_at: createdAt,
            creator,
          },
        ]);
      }
      if (path === '/v1/projects/yvglwblxrnrenfifsnje/branches') {
        return Response.json([
          {
            id: ready.supabaseBranchId,
            project_ref: ready.supabaseProjectRef,
            parent_project_ref: 'yvglwblxrnrenfifsnje',
            is_default: false,
            with_data: false,
            persistent: true,
            status: 'FUNCTIONS_DEPLOYED',
            git_branch: 'integration',
            pr_number: 0,
          },
        ]);
      }
      if (path === `/v1/projects/${ready.supabaseProjectRef}/database/migrations`) {
        return Response.json([{ version: '20260901000000' }]);
      }
      if (url === `${ready.origin}/api/health/version`) {
        return Response.json({
          preview: {
            deploymentId: ready.deploymentId,
            sha: ready.sha,
            supabaseProjectRef: ready.supabaseProjectRef,
          },
        });
      }
      if (url === `${ready.origin}/api/health`) {
        return Response.json({
          status: 'healthy',
          environment: 'preview',
          checks: { database: 'ok' },
        });
      }
      throw new Error('Unexpected readiness request');
    });

    const result = await recoverPreviewE2ERun({
      runId: runA,
      stateRoot: root,
      env,
      observe: (input: Parameters<typeof observePreviewCleanupReadiness>[0]) =>
        observePreviewCleanupReadiness({ ...input, fetchImpl, now: () => fixedNow }),
      createAdmin: () => remoteAdmin.admin,
      resolveServiceKey: async ({ projectRef, provisionToken }) => {
        expect(projectRef).toBe(ready.supabaseProjectRef);
        expect(provisionToken).toBe(env.SUPABASE_PREVIEW_PROVISION_TOKEN);
        return 'sb_secret_preview-test';
      },
      now: () => fixedNow,
    });

    expect(result).toEqual({
      runId: runA,
      status: 'recovered',
      recoveredUserIds: [userA],
      evidenceDirectory,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(remoteAdmin.calls).toContain(`auth:delete:${userA}`);
    expect(remoteAdmin.calls.every((call) => !call.includes(userB))).toBe(true);
    expect(users.has(userA)).toBe(false);
    expect(users.has(userB)).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).status).toBe(
      'recovered',
    );
    expect(JSON.parse(readFileSync(join(root, runB, 'manifest.json'), 'utf8')).status).toBe(
      'failed',
    );
  });

  it('refuses a user whose run marker differs and leaves all tables untouched', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA }]);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runB)]]));

    await expect(recovery(root, runA, remoteAdmin.admin)).rejects.toThrow(
      'ownership does not match',
    );
    expect(remoteAdmin.calls).toEqual([`auth:get:${userA}`]);
  });

  it('does not infer ownership from an unconfirmed create that has no Auth row', async () => {
    const root = workspace();
    const { evidenceDirectory } = addRun(root, runA, [
      { userId: userA, status: 'creation-unconfirmed' },
    ]);
    const remoteAdmin = fakeAdmin(new Map());

    await expect(recovery(root, runA, remoteAdmin.admin)).resolves.toMatchObject({
      status: 'recovered',
      recoveredUserIds: [userA],
    });
    expect(remoteAdmin.calls).toEqual([
      `auth:get:${userA}`,
      `verify:records:user_id:${userA}`,
      `verify:plans:user_id:${userA}`,
      `verify:activities:user_id:${userA}`,
      `verify:categories:user_id:${userA}`,
      `verify:user_settings:user_id:${userA}`,
      `verify:profiles:id:${userA}`,
    ]);
    expect(
      JSON.parse(readFileSync(join(evidenceDirectory, 'users', `${userA}.json`), 'utf8')).status,
    ).toBe('deleted');
  });

  it('refuses app-row cleanup when Auth ownership cannot be reconfirmed', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA, status: 'created' }]);
    const remoteAdmin = fakeAdmin(new Map(), '', 'profiles');

    await expect(recovery(root, runA, remoteAdmin.admin)).rejects.toThrow(
      'Auth ownership marker is missing',
    );
    expect(remoteAdmin.calls[0]).toBe(`auth:get:${userA}`);
    expect(remoteAdmin.calls).toContain(`verify:profiles:id:${userA}`);
    expect(remoteAdmin.calls.filter((call) => !call.startsWith('verify:'))).toEqual([
      `auth:get:${userA}`,
    ]);
    expect(remoteAdmin.calls).not.toContain(`auth:delete:${userA}`);
  });

  it('retries safely after Auth deletion when all owned table rows are already empty', async () => {
    const root = workspace();
    const { evidenceDirectory } = addRun(root, runA, [{ userId: userA, status: 'created' }]);
    const remoteAdmin = fakeAdmin(new Map());

    await expect(recovery(root, runA, remoteAdmin.admin)).resolves.toMatchObject({
      status: 'recovered',
      recoveredUserIds: [userA],
    });
    expect(remoteAdmin.calls[0]).toBe(`auth:get:${userA}`);
    expect(remoteAdmin.calls).toContain(`verify:records:user_id:${userA}`);
    expect(remoteAdmin.calls).toContain(`verify:profiles:id:${userA}`);
    expect(remoteAdmin.calls.filter((call) => !call.startsWith('verify:'))).toEqual([
      `auth:get:${userA}`,
    ]);
    expect(
      JSON.parse(readFileSync(join(evidenceDirectory, 'users', `${userA}.json`), 'utf8')).status,
    ).toBe('deleted');
  });

  it('keeps partial failures retryable and makes cleanup idempotent', async () => {
    const root = workspace();
    const { directory } = addRun(root, runA, [{ userId: userA }]);
    const users = new Map([[userA, ownedUser(userA, runA)]]);
    const failedAdmin = fakeAdmin(users, 'plans');

    await expect(recovery(root, runA, failedAdmin.admin)).rejects.toThrow('could not clean plans');
    expect(failedAdmin.calls).toContain(`records:user_id:${userA}`);
    expect(failedAdmin.calls).toContain(`verify:records:user_id:${userA}`);
    expect(failedAdmin.calls).not.toContain(`auth:delete:${userA}`);
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).status).toBe(
      'recovery-failed',
    );

    const retryAdmin = fakeAdmin(users);
    await expect(recovery(root, runA, retryAdmin.admin)).resolves.toMatchObject({
      status: 'recovered',
      recoveredUserIds: [userA],
    });
  });

  it('does not delete Auth until every exact user table is empty', async () => {
    const root = workspace();
    addRun(root, runA, [{ userId: userA }]);
    const users = new Map([[userA, ownedUser(userA, runA)]]);
    const remoteAdmin = fakeAdmin(users, '', 'profiles');

    await expect(recovery(root, runA, remoteAdmin.admin)).rejects.toThrow(
      'could not verify profiles',
    );
    expect(remoteAdmin.calls).toContain(`profiles:id:${userA}`);
    expect(remoteAdmin.calls).toContain(`verify:profiles:id:${userA}`);
    expect(remoteAdmin.calls).not.toContain(`auth:delete:${userA}`);
    expect(users.has(userA)).toBe(true);
  });

  it('rejects production/malformed run scopes and does not list invalid manifests', async () => {
    const root = workspace();
    const { directory } = addRun(root, runA, [{ userId: userA }]);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    manifest.candidate.supabaseProjectRef = 'yvglwblxrnrenfifsnje';
    writePreviewRunManifest(directory, manifest);
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));

    await expect(recovery(root, runA, remoteAdmin.admin)).rejects.toThrow('manifest is invalid');
    expect(remoteAdmin.calls).toEqual([]);
    expect(listPreviewRecoveryRuns(root)).toEqual([]);
    await expect(recovery(root, '../production', remoteAdmin.admin)).rejects.toThrow(
      'valid Preview',
    );
  });

  it('rejects a run-directory symlink before any remote access', async () => {
    const root = workspace();
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o700 });
    addRun(target, runA, [{ userId: userA }]);
    symlinkSync(join(target, runA), join(root, runA));
    const remoteAdmin = fakeAdmin(new Map([[userA, ownedUser(userA, runA)]]));

    await expect(recovery(root, runA, remoteAdmin.admin)).rejects.toThrow(
      'manifest permissions are invalid',
    );
    expect(remoteAdmin.calls).toEqual([]);
  });

  it('uses an explicit stable state directory and ignores unknown environment paths', () => {
    expect(previewE2EStateRoot({ E2E_PREVIEW_STATE_DIR: '/tmp/dayopt-state' }, '/home/user')).toBe(
      '/tmp/dayopt-state',
    );
    expect(previewE2EStateRoot({}, '/home/user')).toBe(
      '/home/user/.local/state/dayopt/preview-e2e',
    );
  });

  it('requires a clean checkout matching current origin/main before recovery', () => {
    expect(() =>
      requireTrustedRecoverySource({
        headSha: 'a'.repeat(40),
        originMainSha: 'a'.repeat(40),
        clean: true,
      }),
    ).not.toThrow();
    expect(() =>
      requireTrustedRecoverySource({
        headSha: 'a'.repeat(40),
        originMainSha: 'b'.repeat(40),
        clean: true,
      }),
    ).toThrow('clean checkout of the current origin/main');
    expect(() =>
      requireTrustedRecoverySource({
        headSha: 'a'.repeat(40),
        originMainSha: 'a'.repeat(40),
        clean: false,
      }),
    ).toThrow('clean checkout of the current origin/main');
  });
});
