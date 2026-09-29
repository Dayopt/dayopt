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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';
import { loadPreviewFixtureRegistry } from '../../apps/product/src/lib/test/preview-fixture-registry';
import { createPreviewArtifactZip } from '../__tests__/helpers/preview-artifact-zip';
import {
  decryptPreviewFixtureEnvelope,
  encryptPreviewFixtureEnvelope,
  generatePreviewFixtureKeyPair,
} from './preview-fixture-envelope.mjs';
import { previewFixtureHandoffArtifactName } from './preview-fixture-handoff-trust.mjs';
import { receivePreviewFixtureRegistry } from './preview-fixture-handoff.mjs';
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
  function transfer() {
    const args = fixture();
    const { publicKey, privateKey } = generatePreviewFixtureKeyPair();
    const envelope = encryptPreviewFixtureEnvelope({
      input: args.input,
      publicKey,
      payload: args.response,
    });
    const archive = createPreviewArtifactZip([
      { name: 'envelope.json', data: JSON.stringify(envelope) },
    ]);
    const proof = {
      artifactId: 123,
      name: previewFixtureHandoffArtifactName(args.input, 'envelope'),
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    };
    const events: string[] = [];
    const verify = vi.fn(async () => {
      events.push('verify');
      return { ...proof };
    });
    const download = vi.fn(async () => {
      events.push('download');
      return archive;
    });
    return { args, privateKey, proof, archive, verify, download, events };
  }
  function receive(s: ReturnType<typeof transfer>) {
    return receivePreviewFixtureRegistry({
      ...s.args,
      token: 'PRIVATE_READ_TOKEN',
      privateKey: s.privateKey,
      verify: s.verify,
      download: s.download,
    });
  }
  it('verifies, downloads encrypted ZIP, rechecks metadata, then writes private login', async () => {
    const s = transfer();
    const result = await receive(s);
    expect(s.events).toEqual(['verify', 'download', 'verify']);
    expect(JSON.parse(readFileSync(result.path, 'utf8')).users).toEqual(s.args.response.users);
    expect(Object.keys(result).sort()).toEqual(['directory', 'path']);
    expect(s.download).toHaveBeenCalledWith({ artifactId: 123, token: 'PRIVATE_READ_TOKEN' });
  });
  it.each(['before', 'download', 'digest', 'after', 'replaced', 'wrong-key', 'payload'])(
    'leaves no login file after %s failure',
    async (mode) => {
      const s = transfer();
      if (mode === 'before') s.verify.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_BODY'));
      if (mode === 'download') s.download.mockRejectedValueOnce(new Error('PRIVATE_READ_TOKEN'));
      if (mode === 'digest')
        s.download.mockResolvedValueOnce(Buffer.from('untrusted corrupt archive'));
      if (mode === 'after')
        s.verify.mockResolvedValueOnce(s.proof).mockRejectedValueOnce(new Error('PRIVATE'));
      if (mode === 'replaced')
        s.verify
          .mockResolvedValueOnce(s.proof)
          .mockResolvedValueOnce({ ...s.proof, artifactId: 124 });
      if (mode === 'wrong-key') s.privateKey = generatePreviewFixtureKeyPair().privateKey;
      if (mode === 'payload') {
        const { publicKey, privateKey } = generatePreviewFixtureKeyPair();
        s.privateKey = privateKey;
        const envelope = encryptPreviewFixtureEnvelope({
          input: s.args.input,
          publicKey,
          payload: { ...s.args.response, adminKey: 'PRIVATE' },
        });
        const archive = createPreviewArtifactZip([
          { name: 'envelope.json', data: JSON.stringify(envelope) },
        ]);
        s.proof.digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
        s.download.mockResolvedValue(archive);
      }
      await expect(receive(s)).rejects.toThrow(new Error('Preview fixture handoff failed'));
      expect(readdirSync(s.args.runnerTemp).sort()).toEqual(['browser', 'evidence']);
      if (mode === 'before') expect(s.download).not.toHaveBeenCalled();
      if (mode === 'digest') expect(s.verify).toHaveBeenCalledTimes(1);
    },
  );
  it('materializes the decrypted broker payload without exposing login in the transferable envelope', () => {
    const args = fixture();
    const { publicKey, privateKey } = generatePreviewFixtureKeyPair();
    const envelope = encryptPreviewFixtureEnvelope({
      input: args.input,
      publicKey,
      payload: args.response,
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(args.response.users.desktop.password);
    expect(serialized).not.toContain(args.response.users.mobile.email);
    expect(serialized).not.toContain(privateKey);
    const response = decryptPreviewFixtureEnvelope({
      input: args.input,
      privateKey,
      envelope: JSON.parse(serialized),
    });
    const result = writeFixtureRegistry({ ...args, response });
    expect(JSON.parse(readFileSync(result.path, 'utf8')).users).toEqual(args.response.users);
  });
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
