import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { preparePreviewFixtureKeyCustody } from '../lib/preview-fixture-key-custody.mjs';
import { consumePreparedPreviewFixtures } from './preview-prepared-consumer.mjs';
const input = {
  operation: 'provision',
  origin: 'https://product-example123-dayopt.vercel.app',
  execution: { runId: 36508374884, attempt: 1, workflowSha: 'b'.repeat(40) },
  intent: {
    schemaVersion: 1,
    repository: 'Dayopt/dayopt',
    workflow: '.github/workflows/ci.yml',
    workflowRef: 'refs/heads/integration',
    workflowSha: 'b'.repeat(40),
    sourceRunId: 36508374884,
    sourceAttempt: 1,
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-29T00:00:00.000Z',
    userIds: {
      desktop: '11111111-1111-4111-8111-111111111111',
      mobile: '22222222-2222-4222-8222-222222222222',
    },
    request: {
      sha: 'a'.repeat(40),
      deploymentId: 'dpl_example123',
      prNumber: 2954,
      branchName: 'codex/example',
      databaseMode: 'ephemeral',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      supabaseBranchId: '33333333-3333-4333-8333-333333333333',
    },
  },
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup() {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'prepared-consumer-'));
  roots.push(runnerTemp);
  const privateOutput = join(runnerTemp, 'browser'),
    evidenceDirectory = join(runnerTemp, 'evidence');
  mkdirSync(privateOutput);
  mkdirSync(evidenceDirectory);
  const options = { input, runnerTemp, privateOutput, evidenceDirectory };
  const custody = preparePreviewFixtureKeyCustody(options);
  const directory = join(runnerTemp, 'login');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'registry.json');
  writeFileSync(path, 'synthetic-private', { mode: 0o600 });
  const receive = vi.fn(async () => ({
    path,
    directory,
    trustedOidcToken: 'synthetic.preview.access',
  }));
  const prepareCandidate = vi.fn(async () => {
    expect(existsSync(custody.privatePath)).toBe(false);
    expect(receive).toHaveBeenCalledOnce();
    return { root: '/reviewed/candidate', expectedMigrations: ['20260930082108'] };
  });
  const run = vi.fn(async (args) => {
    expect(args.registryPath).toBe(path);
    expect(args.trustedOidcToken).toBe('synthetic.preview.access');
    return {
      runId: input.intent.runId,
      status: 'failed',
      failure: 'cleanup-unconfirmed',
      before: args.request,
      after: null,
      cleanup: { status: 'deferred', checked: 0, recovered: 0 },
      evidenceDirectory,
    };
  });
  return {
    ...options,
    ...custody,
    receive,
    prepareCandidate,
    run,
    token: 'read-only-github',
    env: {},
    path,
  };
}
it('destroys the real private key before checkout, passes the registry, and removes private login after execution', async () => {
  const s = setup();
  const result = await consumePreparedPreviewFixtures(s);
  expect(s.prepareCandidate).toHaveBeenCalledOnce();
  expect(s.run).toHaveBeenCalledOnce();
  expect(result.status).toBe('failed');
  expect(existsSync(s.path)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('synthetic');
});
it('handoff failure never checks out candidate and still destroys the private key', async () => {
  const s = setup();
  s.receive.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_BODY'));
  await expect(consumePreparedPreviewFixtures(s)).rejects.toThrow(
    /^Prepared Preview consumer failed$/,
  );
  expect(s.prepareCandidate).not.toHaveBeenCalled();
  expect(s.run).not.toHaveBeenCalled();
  expect(existsSync(s.privatePath)).toBe(false);
});
it('execution failure removes the registry without exposing process errors', async () => {
  const s = setup();
  s.run.mockRejectedValueOnce(new Error('PRIVATE_PROCESS_ENV'));
  await expect(consumePreparedPreviewFixtures(s)).rejects.toThrow(
    /^Prepared Preview consumer failed$/,
  );
  expect(existsSync(s.path)).toBe(false);
});
it('rejects an OIDC issuer capability before receiving credentials or checking out candidate', async () => {
  const s = setup();
  await expect(
    consumePreparedPreviewFixtures({ ...s, env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private' } }),
  ).rejects.toThrow();
  expect(s.receive).not.toHaveBeenCalled();
  expect(s.prepareCandidate).not.toHaveBeenCalled();
  expect(existsSync(s.privatePath)).toBe(false);
});
