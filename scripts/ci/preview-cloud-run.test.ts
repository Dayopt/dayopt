import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertCloudFixtureKey,
  cleanupCloudRun,
  publishCloudEvidence,
  validateCloudRequest,
  verifyCloudFixtureContract,
} from './preview-cloud-run.mjs';

const request = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_safe123',
  prNumber: 2948,
  branchName: 'codex/candidate',
  supabaseProjectRef: 'tilwaprottpyhlfoggbb',
  supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
  databaseMode: 'shared',
};
const runId = 'b617105b-9c87-44c0-b5f8-18071be8c0f9';
const userId = 'd707d390-8ad2-4776-8e46-7364f6cd7145';
const roots: string[] = [];
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-evidence-test-'));
  roots.push(root);
  const directory = join(root, 'run');
  mkdirSync(join(directory, 'evidence', 'users'), { recursive: true });
  writeFileSync(
    join(directory, 'evidence', 'run.json'),
    JSON.stringify({
      runId,
      status: 'failed',
      before: {
        ...request,
        origin: 'https://product-test123-dayopt.vercel.app',
        migrationVersions: ['20260928044000'],
      },
      ...overrides,
      password: 'PRIVATE_PASSWORD',
      token: 'PRIVATE_TOKEN',
      failure: 'PRIVATE_ERROR',
    }),
  );
  writeFileSync(
    join(directory, 'evidence', 'users', `${userId}.json`),
    JSON.stringify({ runId, userId, status: 'cleanup-failed', email: 'PRIVATE_EMAIL' }),
  );
  return { directory, destination: join(root, 'public'), request };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Cloud Preview evidence and cleanup', () => {
  it('rejects candidates that would ignore the precommitted fixture IDs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-fixture-contract-'));
    roots.push(root);
    const paths = [
      'apps/product/src/lib/test/preview-cloud-identity.ts',
      'apps/product/src/lib/test/e2e/critical-path-fixture.ts',
    ];
    for (const path of paths) {
      const file = join(root, path);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, readFileSync(path));
    }
    expect(() => verifyCloudFixtureContract(root)).not.toThrow();
    writeFileSync(
      join(root, paths[1]),
      'export function createCriticalPathIdentity(){return {userId:crypto.randomUUID()}}',
    );
    expect(() => verifyCloudFixtureContract(root)).toThrow('fixture contract differs');
    rmSync(join(root, paths[0]));
    expect(() => verifyCloudFixtureContract(root)).toThrow();
  });
  it('rejects Production and malformed identifiers before any recovery', () => {
    expect(() =>
      validateCloudRequest({ ...request, supabaseProjectRef: 'yvglwblxrnrenfifsnje' }),
    ).toThrow();
    expect(() => validateCloudRequest({ ...request, branchName: 'candidate\nTOKEN=x' })).toThrow();
  });
  it('publishes interrupted execution as a terminal failure', () => {
    const options = fixture({ status: 'running' });
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      cleanupConfirmed: false,
      testsPassed: false,
    });
  });
  it('reconstructs only allowlisted metadata and ownership journal identifiers', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'e2e.json'),
      JSON.stringify({
        tests: [
          {
            file: 'critical-path.spec.ts',
            project: 'chromium',
            line: 1,
            retry: 0,
            status: 'failed',
            expectedPassed: true,
            title: 'PRIVATE_TITLE',
            error: 'PRIVATE_ERROR',
            headers: 'PRIVATE_TOKEN',
          },
        ],
      }),
    );
    writeFileSync(join(options.directory, 'evidence', 'screenshot.png'), 'PRIVATE_SCREENSHOT');
    const result = publishCloudEvidence(options);
    expect(result.users).toEqual([{ userId, runId, status: 'cleanup-failed' }]);
    const serialized = readFileSync(join(options.destination, 'preview.json'), 'utf8');
    expect(serialized).not.toContain('PRIVATE_');
    expect(result.tests).toHaveLength(1);
  });
  it('refuses a changed candidate binding before recovery and before artifact creation', async () => {
    const options = fixture({ before: { ...request, sha: 'b'.repeat(40) } });
    const recover = vi.fn();
    await expect(cleanupCloudRun({ ...options, serviceKey: 'unused', recover })).rejects.toThrow();
    expect(recover).not.toHaveBeenCalled();
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      runBindingConfirmed: false,
    });
  });
  it('rejects a key for another project before any HTTP request', async () => {
    const fetchImpl = vi.fn();
    const claims = Buffer.from(
      JSON.stringify({ role: 'service_role', ref: 'yvglwblxrnrenfifsnje' }),
    ).toString('base64url');
    await expect(
      assertCloudFixtureKey({ request, serviceKey: `header.${claims}.signature`, fetchImpl }),
    ).rejects.toThrow('binding differs');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('authenticates an opaque key only at the selected nonproduction baseline endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', email: 'PRIVATE_EMAIL' }),
          { status: 200 },
        ),
      );
    await assertCloudFixtureKey({ request, serviceKey: 'sb_secret_safe-dummy', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://tilwaprottpyhlfoggbb.supabase.co/auth/v1/admin/users/00000000-0000-0000-0000-000000000001',
    );
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    fetchImpl.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR', { status: 401 }));
    await expect(
      assertCloudFixtureKey({ request, serviceKey: 'sb_secret_wrong', fetchImpl }),
    ).rejects.toThrow('key or baseline is not ready');
  });
  it('publishes a failed binding marker when execution stopped before a run journal existed', () => {
    const options = fixture();
    rmSync(join(options.directory, 'evidence', 'run.json'));
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      runBindingConfirmed: false,
      cleanupConfirmed: false,
    });
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
  it('invokes recovery for the bound run and selected database only', async () => {
    const options = fixture();
    const recover = vi.fn().mockResolvedValue({ status: 'clean', checked: 1, recovered: 1 });
    await cleanupCloudRun({ ...options, serviceKey: 'safe-dummy-key', recover });
    expect(recover).toHaveBeenCalledWith({
      evidenceDirectory: join(options.directory, 'evidence'),
      runId,
      supabaseProjectRef: request.supabaseProjectRef,
      serviceKey: 'safe-dummy-key',
    });
  });
  it('does not publish an ownership journal claiming another run', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'users', `${userId}.json`),
      JSON.stringify({ runId: userId, userId, status: 'created', secret: 'PRIVATE_SECRET' }),
    );
    expect(publishCloudEvidence(options).users).toEqual([]);
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
});
