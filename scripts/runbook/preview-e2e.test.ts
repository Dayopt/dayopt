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
  isPassingPreviewReport,
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

function reviewedReport() {
  const tests = [
    ...Array.from({ length: 9 }, (_, index) => ({
      file: 'critical-path.spec.ts',
      project: 'chromium',
      line: index + 1,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      file: 'mobile-critical-path.spec.ts',
      project: 'Mobile Chrome',
      line: index + 1,
    })),
  ].map((row) => ({ ...row, status: 'passed', expectedPassed: true, retry: 0 }));
  return { status: 'passed', expected: 12, tests };
}

describe('Reviewed Preview declaration matrix', () => {
  it('accepts exactly the reviewed nine desktop and three mobile declarations', () => {
    expect(isPassingPreviewReport(reviewedReport())).toBe(true);
  });
  it('rejects the old seven declarations even if their dynamic expected count agrees', () => {
    const report = reviewedReport();
    report.tests.splice(4, 5);
    report.expected = 7;
    expect(isPassingPreviewReport(report)).toBe(false);
  });
  it('rejects missing added coverage despite a matching dynamic count', () => {
    const report = reviewedReport();
    report.tests.splice(8, 1);
    report.expected = 11;
    expect(isPassingPreviewReport(report)).toBe(false);
  });
  it('rejects duplicate declaration locations that replace a new case', () => {
    const report = reviewedReport();
    report.tests[8] = { ...report.tests[0]! };
    expect(isPassingPreviewReport(report)).toBe(false);
  });
  it('rejects the right counts under the wrong file/project pairing', () => {
    const report = reviewedReport();
    report.tests[0]!.file = 'mobile-critical-path.spec.ts';
    expect(isPassingPreviewReport(report)).toBe(false);
  });
  it('rejects twelve distinct declarations split as eight desktop and four mobile', () => {
    const report = reviewedReport();
    report.tests[8] = { ...report.tests[9]!, line: 4 };
    expect(isPassingPreviewReport(report)).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe declaration line %s',
    (line) => {
      const report = reviewedReport();
      report.tests[0]!.line = line;
      expect(isPassingPreviewReport(report)).toBe(false);
    },
  );
});

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'preview-runner-test-'));
  roots.push(root);
  const observe = vi.fn(async () => ready);
  const execute = vi.fn(async (workerEnv: Record<string, string>) => {
    writeFileSync(join(workerEnv.E2E_PREVIEW_PRIVATE_DIR!, 'trace.zip'), 'private');
    writeFileSync(
      join(workerEnv.E2E_PREVIEW_EVIDENCE_DIR!, 'e2e.json'),
      JSON.stringify(reviewedReport()),
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
  it('runs the credentialed harness only from the trusted checkout, ignoring a candidate root', async () => {
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
fs.writeFileSync(path.join(process.env.E2E_PREVIEW_EVIDENCE_DIR, 'worker-observation.json'), JSON.stringify({cwd:process.cwd(), hasManagement: Boolean(process.env.GITHUB_TOKEN || process.env.VERCEL_TOKEN || process.env.SUPABASE_PREVIEW_READINESS_TOKEN || process.env.STRIPE_SECRET_KEY), runId:process.env.E2E_PREVIEW_RUN_ID, cloudIntent:process.env.E2E_PREVIEW_CLOUD_INTENT, desktop:process.env.E2E_PREVIEW_DESKTOP_USER_ID, mobile:process.env.E2E_PREVIEW_MOBILE_USER_ID}));
fs.writeFileSync(path.join(process.env.E2E_PREVIEW_EVIDENCE_DIR, 'e2e.json'), JSON.stringify(${JSON.stringify(reviewedReport())}));
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
      ...{ candidateRoot },
      runDirectory,
      runId,
      cloudUserIds,
      observe: s.observe,
      recover: s.recover,
    });
    expect(result.status).toBe('passed');
    expect(result.evidenceDirectory).toBe(join(runDirectory, 'evidence'));
    expect(
      JSON.parse(readFileSync(join(result.evidenceDirectory, 'worker-observation.json'), 'utf8')),
    ).toEqual({
      cwd: realpathSync(process.cwd()),
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
        JSON.stringify(reviewedReport()),
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
      reporter.onBegin({}, { allTests: () => reviewedReport().tests });
      for (const [index, declaration] of reviewedReport().tests.entries()) {
        const test = {
          id: String(index),
          expectedStatus: 'passed',
          location: { file: `/repo/${declaration.file}`, line: declaration.line },
          parent: { project: () => ({ name: declaration.project }) },
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
