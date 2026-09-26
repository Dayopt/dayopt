import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
};
const env = {
  SUPABASE_SECRET_KEY: 'synthetic-admin',
  VERCEL_TOKEN: 'management-private',
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
  return { root, observe, execute };
}

describe('Preview E2E runner', () => {
  it('前後の照合とE2Eを実行し、private成果物を残さない', async () => {
    const s = scenario();
    const result = await runPreviewE2E({
      request: {},
      env,
      observe: s.observe,
      execute: s.execute,
      tempRoot: s.root,
    });
    expect(result.status).toBe('passed');
    expect(s.observe).toHaveBeenCalledTimes(2);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(existsSync(join(result.evidenceDirectory, '..', 'private'))).toBe(false);
    expect(readFileSync(join(result.evidenceDirectory, 'run.json'), 'utf8')).not.toContain(
      'private',
    );
  });
  it('readiness失敗時はE2Eを起動しない', async () => {
    const s = scenario();
    s.observe.mockRejectedValueOnce(new Error('private'));
    await expect(
      runPreviewE2E({ request: {}, env, observe: s.observe, execute: s.execute, tempRoot: s.root }),
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
      tempRoot: s.root,
    });
    expect(result).toMatchObject({ status: 'failed', failure: 'e2e-evidence-missing' });
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
      reporter.onBegin({}, { allTests: () => [1, 2] });
      for (const [index, project] of ['chromium', 'Mobile Chrome'].entries()) {
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
