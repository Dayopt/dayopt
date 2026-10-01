import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PreviewE2EReporter, {
  safePreviewNetwork,
  safePreviewStep,
} from '../lib/preview-e2e-reporter.mjs';
import { previewWorkerEnvironment, runPreviewE2E } from './preview-e2e.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const ready = {
  status: 'ready',
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test',
  prNumber: 2910,
  branchName: 'codex/test',
  databaseMode: 'ephemeral',
  supabaseBranchId: '11111111-1111-1111-1111-111111111111',
  migrationVersions: ['20260901000000'],
  startedAt: '2026-09-27T00:00:00Z',
  observedAt: '2026-09-27T00:00:01Z',
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  origin: 'https://product-abc123-dayopt.vercel.app',
  providerEvidence: {
    provider: 'vercel',
    repository: 'Dayopt/dayopt',
    environment: 'Preview – product',
    sha: 'a'.repeat(40),
    branchName: 'codex/test',
    prNumber: 2910,
    vercelDeploymentId: 'dpl_test',
    githubDeploymentId: 6708659866,
    githubDeploymentStatusId: 18941762944,
    githubCommitStatusId: 55073316235,
    creatorId: 35613825,
    deploymentCreatedAt: '2026-09-27T00:00:00Z',
    deploymentStatusCreatedAt: '2026-09-27T00:00:00Z',
    commitStatusCreatedAt: '2026-09-27T00:00:00Z',
    observedAt: '2026-09-27T00:00:01Z',
  },
};
const env = {
  SUPABASE_SECRET_KEY: 'synthetic-admin',
  GITHUB_TOKEN: 'github-private',
  VERCEL_TOKEN: 'production-vercel-private',
  SUPABASE_PREVIEW_READINESS_TOKEN: 'management-private',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-private',
  STRIPE_SECRET_KEY: 'production-private',
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'preview-runner-test-'));
  roots.push(root);
  const observe = vi.fn(async () => ready);
  const execute = vi.fn(async (workerEnv: Record<string, string>) => {
    writeFileSync(join(workerEnv.E2E_PREVIEW_PRIVATE_DIR!, 'trace.zip'), 'private');
    writeFileSync(
      join(workerEnv.E2E_PREVIEW_EVIDENCE_DIR!, 'e2e.json'),
      JSON.stringify({
        status: 'passed',
        expected: 2,
        tests: ['chromium', 'Mobile Chrome'].map((project) => ({
          file: 'critical-path.spec.ts',
          project,
          status: 'passed',
          expectedPassed: true,
          retry: 0,
        })),
      }),
    );
    return 0;
  });
  const recover = vi.fn(async () => ({ status: 'clean', checked: 2, recovered: 0 }));
  return { root, observe, execute, recover };
}

describe('Preview E2E runner', () => {
  it('前後の照合とE2Eを実行し、private成果物を残さない', async () => {
    const s = scenario();
    let startedManifest: Record<string, unknown> | undefined;
    const result = await runPreviewE2E({
      request: {},
      env,
      observe: s.observe,
      execute: s.execute,
      recover: s.recover,
      tempRoot: s.root,
      onStarted: ({ evidenceDirectory }) => {
        startedManifest = JSON.parse(
          readFileSync(join(evidenceDirectory, '..', 'manifest.json'), 'utf8'),
        );
      },
    });
    expect(result.status).toBe('passed');
    expect(s.observe).toHaveBeenCalledTimes(2);
    expect(s.observe).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: 'github-private' }),
    );
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(startedManifest).toMatchObject({ runId: result.runId, status: 'running' });
    const runDirectory = join(result.evidenceDirectory, '..');
    const manifest = JSON.parse(readFileSync(join(runDirectory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      runId: result.runId,
      status: 'passed',
      evidenceDirectory: result.evidenceDirectory,
    });
    expect(JSON.stringify(manifest)).not.toMatch(/synthetic-admin|private|bypass-private/i);
    expect(statSync(runDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(runDirectory, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(result.evidenceDirectory, '..', 'private'))).toBe(false);
    expect(readFileSync(join(result.evidenceDirectory, 'run.json'), 'utf8')).not.toContain(
      'private',
    );
  });
  it('trusted supervisor starts the candidate worker in its own checkout without management tokens', async () => {
    const s = scenario();
    const candidateRoot = join(s.root, 'candidate');
    const bin = join(s.root, 'bin');
    mkdirSync(candidateRoot);
    mkdirSync(bin);
    const executable = join(bin, 'pnpm');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'worker-observation.json'), JSON.stringify({cwd:process.cwd(), hasManagement: Boolean(process.env.GITHUB_TOKEN || process.env.VERCEL_TOKEN || process.env.SUPABASE_PREVIEW_READINESS_TOKEN || process.env.STRIPE_SECRET_KEY), runId:process.env.E2E_PREVIEW_RUN_ID, cloudIntent:process.env.E2E_PREVIEW_CLOUD_INTENT, desktop:process.env.E2E_PREVIEW_DESKTOP_USER_ID, mobile:process.env.E2E_PREVIEW_MOBILE_USER_ID}));
fs.writeFileSync(path.join(process.env.E2E_PREVIEW_EVIDENCE_DIR, 'e2e.json'), JSON.stringify({status:'passed',expected:2,tests:['chromium','Mobile Chrome'].map(project=>({file:'critical-path.spec.ts',project,status:'passed',expectedPassed:true,retry:0}))}));
`,
    );
    chmodSync(executable, 0o700);
    const runDirectory = join(s.root, 'cloud-run');
    const runId = '11111111-1111-4111-8111-111111111111';
    const cloudUserIds = {
      desktop: '22222222-2222-4222-8222-222222222222',
      mobile: '33333333-3333-4333-8333-333333333333',
    };
    const result = await runPreviewE2E({
      request: {},
      env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      candidateRoot,
      runDirectory,
      runId,
      cloudUserIds,
      observe: s.observe,
      recover: s.recover,
    });
    expect(result.status).toBe('passed');
    expect(result.evidenceDirectory).toBe(join(runDirectory, 'evidence'));
    expect(
      JSON.parse(readFileSync(join(candidateRoot, 'worker-observation.json'), 'utf8')),
    ).toEqual({
      cwd: realpathSync(candidateRoot),
      hasManagement: false,
      runId,
      cloudIntent: '1',
      ...cloudUserIds,
    });
    expect(existsSync(join(runDirectory, 'private'))).toBe(false);
  });
  it('readiness失敗時はE2Eを起動しない', async () => {
    const s = scenario();
    s.observe.mockRejectedValueOnce(new Error('private'));
    await expect(
      runPreviewE2E({
        request: {},
        env,
        observe: s.observe,
        execute: s.execute,
        recover: s.recover,
        tempRoot: s.root,
      }),
    ).rejects.toThrow();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it('後段のDB等の不一致はE2E成功でも失敗', async () => {
    const s = scenario();
    s.observe.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('private'));
    const result = await runPreviewE2E({
      request: {},
      env,
      observe: s.observe,
      execute: s.execute,
      recover: s.recover,
      tempRoot: s.root,
    });
    expect(result).toMatchObject({ status: 'failed', failure: 'post-readiness-failed' });
  });
  it('終了コード0だけで合格にしない', async () => {
    const s = scenario();
    s.execute.mockImplementationOnce(async () => 0);
    const result = await runPreviewE2E({
      request: {},
      env,
      observe: s.observe,
      execute: s.execute,
      recover: s.recover,
      tempRoot: s.root,
    });
    expect(result).toMatchObject({ status: 'failed', failure: 'e2e-evidence-missing' });
  });
  it('E2E成功でもcleanup未確認は失敗し、開始時の回復用bindingを保存する', async () => {
    const s = scenario();
    s.execute.mockImplementationOnce(async (workerEnv: Record<string, string>) => {
      const started = JSON.parse(
        readFileSync(join(workerEnv.E2E_PREVIEW_EVIDENCE_DIR!, 'run.json'), 'utf8'),
      );
      expect(started.status).toBe('running');
      expect(started.before).toEqual(ready);
      expect(started.runId).toBe(workerEnv.E2E_PREVIEW_RUN_ID);
      writeFileSync(
        join(workerEnv.E2E_PREVIEW_EVIDENCE_DIR!, 'e2e.json'),
        JSON.stringify({
          status: 'passed',
          expected: 2,
          tests: ['chromium', 'Mobile Chrome'].map((project) => ({
            file: 'critical-path.spec.ts',
            project,
            status: 'passed',
            expectedPassed: true,
            retry: 0,
          })),
        }),
      );
      return 0;
    });
    s.recover.mockResolvedValueOnce({ status: 'failed', checked: 2, recovered: 0 });
    const result = await runPreviewE2E({
      request: {},
      env,
      observe: s.observe,
      execute: s.execute,
      recover: s.recover,
      tempRoot: s.root,
    });
    expect(result).toMatchObject({ status: 'failed', failure: 'cleanup-unconfirmed' });
    expect(s.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        supabaseProjectRef: ready.supabaseProjectRef,
      }),
    );
  });
  it('preprovisioned worker gets only scoped logins and no admin or OIDC authority', () => {
    const ids = {
      desktop: '22222222-2222-4222-8222-222222222222',
      mobile: '33333333-3333-4333-8333-333333333333',
    };
    const parent = {
      ...env,
      GH_TOKEN: 'must-not-leak',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'must-not-leak',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'must-not-leak',
      NODE_OPTIONS: 'must-not-leak',
      E2E_PREVIEW_FIXTURE_REGISTRY: 'untrusted-parent-path',
    };
    const worker = previewWorkerEnvironment(
      parent,
      ready,
      '/private',
      '/evidence',
      '11111111-1111-4111-8111-111111111111',
      ids,
      '/credentials/login.json',
      'synthetic.preview.access',
    );
    expect(worker).toMatchObject({
      E2E_PREVIEW_FIXTURE_REGISTRY: '/credentials/login.json',
      E2E_PREVIEW_DB_MODE: 'ephemeral',
      E2E_PREVIEW_CLOUD_INTENT: '1',
      E2E_PREVIEW_DESKTOP_USER_ID: ids.desktop,
      E2E_PREVIEW_MOBILE_USER_ID: ids.mobile,
      E2E_PREVIEW_TRUSTED_OIDC_TOKEN: 'synthetic.preview.access',
    });
    for (const key of [
      'SUPABASE_SECRET_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'VERCEL_TOKEN',
      'SUPABASE_PREVIEW_READINESS_TOKEN',
      'STRIPE_SECRET_KEY',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'NODE_OPTIONS',
    ])
      expect(worker).not.toHaveProperty(key);
    expect(JSON.stringify(worker)).not.toContain('must-not-leak');
    expect(parent.SUPABASE_SECRET_KEY).toBe(env.SUPABASE_SECRET_KEY);
    // Inherited mode hints cannot silently switch legacy execution to the new mode.
    const legacy = previewWorkerEnvironment(
      parent,
      ready,
      '/private',
      '/evidence',
      '11111111-1111-4111-8111-111111111111',
      ids,
    );
    expect(legacy).not.toHaveProperty('E2E_PREVIEW_FIXTURE_REGISTRY');
    expect(legacy).toHaveProperty('SUPABASE_SECRET_KEY', env.SUPABASE_SECRET_KEY);
  });
  it.each([
    'shared',
    'production',
    'not-ready',
    'missing-users',
    'same-users',
    'baseline-user',
    'relative-path',
    'empty-path',
    'bad-run',
    'bad-origin',
  ])('preprovisioned environment fails closed for %s', (scenario) => {
    const binding = { ...ready };
    let ids: { desktop: string; mobile: string } | undefined = {
      desktop: '22222222-2222-4222-8222-222222222222',
      mobile: '33333333-3333-4333-8333-333333333333',
    };
    let path = '/credentials/login.json';
    let runId = '11111111-1111-4111-8111-111111111111';
    if (scenario === 'shared')
      Object.assign(binding, {
        databaseMode: 'shared',
        supabaseProjectRef: 'tilwaprottpyhlfoggbb',
        supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
      });
    if (scenario === 'production') binding.supabaseProjectRef = 'yvglwblxrnrenfifsnje';
    if (scenario === 'not-ready') binding.status = 'failed';
    if (scenario === 'missing-users') ids = undefined;
    if (scenario === 'same-users') ids!.mobile = ids!.desktop;
    if (scenario === 'baseline-user') ids!.desktop = '00000000-0000-0000-0000-000000000001';
    if (scenario === 'relative-path') path = 'login.json';
    if (scenario === 'empty-path') path = '';
    if (scenario === 'bad-run') runId = 'must-not-leak';
    if (scenario === 'bad-origin') binding.origin = 'https://example.com';
    expect(() =>
      previewWorkerEnvironment(env, binding, '/private', '/evidence', runId, ids, path),
    ).toThrow(/^Preview fixture worker binding is invalid$/);
  });
  it('子プロセスには管理tokenと本番secretを渡さない', () => {
    const worker = previewWorkerEnvironment(
      env,
      ready,
      '/private',
      '/evidence',
      '11111111-1111-1111-1111-111111111111',
    );
    expect(worker).not.toHaveProperty('VERCEL_TOKEN');
    expect(worker).not.toHaveProperty('GITHUB_TOKEN');
    expect(worker).not.toHaveProperty('SUPABASE_PREVIEW_READINESS_TOKEN');
    expect(worker).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(worker.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abcdefghijklmnopqrst.supabase.co');
  });
});

describe('Safe failure evidence', () => {
  it('authorization失敗も入力や応答を含めず位置だけ残す', () => {
    expect(
      safePreviewStep({
        category: 'test.step',
        duration: 5,
        location: { file: '/repo/preview-authorization.spec.ts', line: 80 },
        title: 'PRIVATE_USER',
        error: { message: 'PRIVATE_RESPONSE' },
      }),
    ).toEqual({
      category: 'test.step',
      file: 'preview-authorization.spec.ts',
      line: 80,
      duration: 5,
      failed: true,
    });
  });
  it('stepのtitle/引数/error本文を捨てて位置と結果だけ残す', () => {
    const result = safePreviewStep({
      category: 'pw:api',
      title: 'fill(private)',
      params: { value: 'private' },
      error: { message: 'private' },
      duration: 12,
      location: { file: '/repo/critical-path.spec.ts', line: 123 },
    });
    expect(result).toEqual({
      category: 'pw:api',
      file: 'critical-path.spec.ts',
      line: 123,
      duration: 12,
      failed: true,
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('networkの追加フィールドを公開しない', () => {
    expect(
      safePreviewNetwork(
        Buffer.from(
          JSON.stringify([
            { at: 10, target: 'preview', status: 200, headers: 'private', body: 'private' },
          ]),
        ),
      ),
    ).toEqual([{ at: 10, target: 'preview', status: 200 }]);
  });
  it('不正networkデータを拒否', () => {
    expect(safePreviewNetwork(Buffer.from('private'))).toBeNull();
    expect(
      safePreviewNetwork(Buffer.from('[{"target":"private","at":1,"status":200}]')),
    ).toBeNull();
  });
});

describe('Preview reporter completeness', () => {
  it.each(['passed', 'skipped', 'failed'])(
    '全件の結果を判定し、生の例外を保存しない: %s',
    (status) => {
      const root = mkdtempSync(join(tmpdir(), 'preview-reporter-'));
      roots.push(root);
      const reporter = new PreviewE2EReporter({ directory: root });
      reporter.onBegin({}, { allTests: () => [1, 2, 3] });
      for (const [index, project] of [
        'chromium',
        'Mobile Chrome',
        'preview-authorization',
      ].entries()) {
        const test = {
          id: String(index),
          expectedStatus: 'passed',
          location: { file: '/repo/critical-path.spec.ts', line: 5 },
          parent: { project: () => ({ name: project }) },
        };
        reporter.onStepEnd(
          test,
          {},
          {
            category: 'pw:api',
            title: 'private-password',
            error: { message: 'private-token' },
            location: test.location,
            duration: 1,
          },
        );
        reporter.onTestEnd(test, {
          status,
          duration: 1,
          retry: 0,
          errors: [{ message: 'private-token' }],
          stdout: ['private-token'],
          attachments: [
            {
              name: 'preview-network',
              body: Buffer.from('[{"at":1,"target":"preview","status":200}]'),
            },
          ],
        });
      }
      expect(reporter.onEnd({ status: 'passed' })).toEqual({
        status: status === 'passed' ? 'passed' : 'failed',
      });
      expect(readFileSync(join(root, 'e2e.json'), 'utf8')).not.toContain('private-');
    },
  );
});

describe('prepared fixture consumer boundary', () => {
  const users = {
    desktop: '11111111-1111-4111-8111-111111111111',
    mobile: '22222222-2222-4222-8222-222222222222',
  };
  it('passes the trusted registry without admin authority and defers cleanup to a separate job', async () => {
    const s = scenario();
    const result = await runPreviewE2E({
      request: {},
      env: {},
      observe: s.observe,
      execute: s.execute,
      recover: s.recover,
      tempRoot: s.root,
      cloudUserIds: users,
      registryPath: join(s.root, 'registry.json'),
      trustedOidcToken: 'synthetic.preview.access',
    });
    expect(s.execute).toHaveBeenCalledOnce();
    const worker = s.execute.mock.calls[0]![0];
    expect(worker.E2E_PREVIEW_FIXTURE_REGISTRY).toBe(join(s.root, 'registry.json'));
    expect(worker.E2E_PREVIEW_TRUSTED_OIDC_TOKEN).toBe('synthetic.preview.access');
    expect(worker).not.toHaveProperty('SUPABASE_SECRET_KEY');
    expect(worker).not.toHaveProperty('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(s.recover).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.failure).toBe('cleanup-unconfirmed');
    expect(result.cleanup.status).toBe('deferred');
  });
  it.each([
    { SUPABASE_SECRET_KEY: 'do-not-disclose' },
    { VERCEL_AUTOMATION_BYPASS_SECRET: 'do-not-disclose' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'do-not-disclose' },
  ])('rejects privileged prepared consumers before observation', async (unsafe) => {
    const s = scenario();
    await expect(
      runPreviewE2E({
        request: {},
        env: unsafe,
        observe: s.observe,
        tempRoot: s.root,
        registryPath: join(s.root, 'registry.json'),
        trustedOidcToken: 'synthetic.preview.access',
        cloudUserIds: users,
      }),
    ).rejects.toThrow('Prepared Preview consumer credentials are invalid');
    expect(s.observe).not.toHaveBeenCalled();
  });
  it('does not fall back to project bypass when Trusted Sources access is missing', async () => {
    const s = scenario();
    await expect(
      runPreviewE2E({
        request: {},
        env: {},
        observe: s.observe,
        registryPath: join(s.root, 'registry.json'),
        cloudUserIds: users,
      }),
    ).rejects.toThrow('Prepared Preview consumer credentials are invalid');
    expect(s.observe).not.toHaveBeenCalled();
  });
});
