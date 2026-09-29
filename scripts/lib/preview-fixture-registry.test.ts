import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPreviewFixtureRegistry } from '../../apps/product/src/lib/test/preview-fixture-registry';
import { writeFixtureRegistry } from './preview-fixture-registry.mjs';

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
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'registry-writer-test-'));
  roots.push(runnerTemp);
  const privateOutput = join(runnerTemp, 'browser');
  const evidenceDirectory = join(runnerTemp, 'evidence');
  mkdirSync(privateOutput);
  mkdirSync(evidenceDirectory);
  const response = {
    schemaVersion: 1,
    operation: 'provision',
    runId: input.intent.runId,
    users: Object.fromEntries(
      Object.entries(input.intent.userIds).map(([slot, userId]) => [
        slot,
        {
          userId,
          email: `${slot === 'desktop' ? 'critical-path' : 'mobile-critical-path'}-${userId}@example.com`,
          password: `E2e!${'a'.repeat(43)}`,
          activityName: `Journey ${userId.slice(0, 8)}`,
          categoryName: `Cat ${userId.slice(0, 8)}`,
        },
      ]),
    ),
  };
  return { input: structuredClone(input), response, runnerTemp, privateOutput, evidenceDirectory };
}

describe('private fixture registry materialization', () => {
  it('writes a private file accepted by the actual candidate reader outside browser outputs', () => {
    const args = fixture();
    const result = writeFixtureRegistry(args);
    expect(statSync(result.directory).mode & 0o777).toBe(0o700);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    const registry = loadPreviewFixtureRegistry({
      E2E_PREVIEW_FIXTURE_REGISTRY: result.path,
      E2E_PREVIEW_DB_MODE: 'ephemeral',
      E2E_ALLOW_NONLOCAL_SUPABASE: '1',
      E2E_PREVIEW_CLOUD_INTENT: '1',
      E2E_SUPABASE_PROJECT_REF: input.intent.request.supabaseProjectRef,
      NEXT_PUBLIC_SUPABASE_URL: `https://${input.intent.request.supabaseProjectRef}.supabase.co`,
      E2E_PREVIEW_ORIGIN: input.origin,
      E2E_PREVIEW_RUN_ID: input.intent.runId,
      E2E_PREVIEW_DESKTOP_USER_ID: input.intent.userIds.desktop,
      E2E_PREVIEW_MOBILE_USER_ID: input.intent.userIds.mobile,
      E2E_PREVIEW_PRIVATE_DIR: args.privateOutput,
      E2E_PREVIEW_EVIDENCE_DIR: args.evidenceDirectory,
    });
    expect(registry?.users).toEqual(args.response.users);
    expect(readdirSync(args.evidenceDirectory)).toEqual([]);
    expect(readdirSync(args.privateOutput)).toEqual([]);
    const second = writeFixtureRegistry(args);
    expect(second.path).not.toBe(result.path);
    expect(readFileSync(result.path, 'utf8')).toBe(readFileSync(second.path, 'utf8'));
  });
  it.each(['runId', 'extra', 'userId', 'password', 'operation'])(
    'rejects malformed %s without writing credentials',
    (field) => {
      const args = fixture();
      if (field === 'runId') args.response.runId = 'SECRET';
      if (field === 'extra') Object.assign(args.response, { adminKey: 'SECRET' });
      if (field === 'userId') args.response.users.desktop.userId = input.intent.userIds.mobile;
      if (field === 'password') args.response.users.desktop.password = 'SECRET';
      if (field === 'operation') args.response.operation = 'cleanup';
      expect(() => writeFixtureRegistry(args)).toThrow(
        'Preview fixture registry preparation failed',
      );
      expect(readdirSync(args.runnerTemp).sort()).toEqual(['browser', 'evidence']);
    },
  );
  it.each(['privateOutput', 'evidenceDirectory'] as const)(
    'rejects a temp root inside %s even through a symlink',
    (key) => {
      const args = fixture();
      const alias = join(args.runnerTemp, 'alias');
      symlinkSync(args[key], alias);
      expect(() => writeFixtureRegistry({ ...args, runnerTemp: alias })).toThrow(
        'Preview fixture registry preparation failed',
      );
      expect(readdirSync(args[key])).toEqual([]);
    },
  );
});
