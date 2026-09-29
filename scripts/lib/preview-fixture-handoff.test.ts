import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPreviewArtifactZip } from '../__tests__/helpers/preview-artifact-zip';
import {
  encryptPreviewFixtureEnvelope,
  generatePreviewFixtureKeyPair,
} from './preview-fixture-envelope.mjs';
import { previewFixtureHandoffArtifactName } from './preview-fixture-handoff-trust.mjs';
import {
  createPreviewFixturePublicKeyArtifact,
  receivePreviewFixturePublicKey,
  receivePreviewFixtureRegistry,
} from './preview-fixture-handoff.mjs';
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

const pair = generatePreviewFixtureKeyPair();
const invalid = /^Preview fixture handoff failed$/;
function transfer(
  body: unknown = createPreviewFixturePublicKeyArtifact({ input, publicKey: pair.publicKey }),
  role = 'public-key',
) {
  const archive = createPreviewArtifactZip([{ name: `${role}.json`, data: JSON.stringify(body) }]);
  const proof = {
    artifactId: 123,
    name: previewFixtureHandoffArtifactName(input, role),
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
  return { input, token: ' PRIVATE_TOKEN ', proof, verify, download, events };
}
describe('trusted public key handoff with injected GitHub metadata and download', () => {
  it('checks metadata twice around real ZIP/digest parsing and returns only public PEM', async () => {
    const s = transfer();
    expect(await receivePreviewFixturePublicKey(s)).toBe(pair.publicKey);
    expect(s.events).toEqual(['verify', 'download', 'verify']);
    expect(s.verify).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'public-key', token: 'PRIVATE_TOKEN' }),
    );
    expect(s.download).toHaveBeenCalledWith({ artifactId: 123, token: 'PRIVATE_TOKEN' });
  });
  it('normalizes reordered authority keys before comparing binding', async () => {
    const body = createPreviewFixturePublicKeyArtifact({ input, publicKey: pair.publicKey });
    const { audience, execution, intent, origin, operation } = body.binding.authority;
    body.binding.authority = { audience, execution, intent, origin, operation };
    expect(await receivePreviewFixturePublicKey(transfer(body))).toBe(pair.publicKey);
  });
  it.each(['before', 'download', 'digest', 'after', 'id', 'name', 'changed-digest'])(
    'rejects %s without returning a key',
    async (mode) => {
      const s = transfer();
      if (mode === 'before') s.verify.mockRejectedValueOnce(new Error('PRIVATE_METADATA'));
      if (mode === 'download') s.download.mockRejectedValueOnce(new Error('PRIVATE_TOKEN'));
      if (mode === 'digest') s.download.mockResolvedValueOnce(Buffer.from('wrong bytes'));
      if (mode === 'after')
        s.verify.mockResolvedValueOnce(s.proof).mockRejectedValueOnce(new Error('PRIVATE'));
      if (mode === 'id')
        s.verify
          .mockResolvedValueOnce(s.proof)
          .mockResolvedValueOnce({ ...s.proof, artifactId: 456 });
      if (mode === 'name')
        s.verify.mockResolvedValueOnce({
          ...s.proof,
          name: previewFixtureHandoffArtifactName(input, 'envelope'),
        });
      if (mode === 'changed-digest')
        s.verify
          .mockResolvedValueOnce(s.proof)
          .mockResolvedValueOnce({ ...s.proof, digest: `sha256:${'0'.repeat(64)}` });
      await expect(receivePreviewFixturePublicKey(s)).rejects.toThrow(invalid);
      if (mode === 'before' || mode === 'name') expect(s.download).not.toHaveBeenCalled();
      if (mode === 'digest') expect(s.verify).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['version', 'extra', 'digest', 'origin', 'audience', 'attempt', 'key', 'private'])(
    'rejects authenticated but invalid %s body',
    async (mode) => {
      const body = createPreviewFixturePublicKeyArtifact({ input, publicKey: pair.publicKey });
      if (mode === 'version') body.schemaVersion = 2;
      if (mode === 'extra') Object.assign(body, { secret: 'PRIVATE' });
      if (mode === 'digest') body.binding.publicKeyDigest = '0'.repeat(64);
      if (mode === 'origin')
        body.binding.authority.origin = 'https://product-other123-dayopt.vercel.app';
      if (mode === 'audience') body.binding.authority.audience = 'other';
      if (mode === 'attempt') body.binding.authority.execution.attempt = 2;
      if (mode === 'key') body.publicKey = generatePreviewFixtureKeyPair().publicKey;
      if (mode === 'private') body.publicKey = pair.privateKey;
      await expect(receivePreviewFixturePublicKey(transfer(body))).rejects.toThrow(invalid);
    },
  );
  it('rejects weak RSA, non-RSA and non-public PEM before publication', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    for (const publicKey of [weak, ec, pair.privateKey, 'bad', pair.publicKey + pair.publicKey])
      expect(() => createPreviewFixturePublicKeyArtifact({ input, publicKey })).toThrow(invalid);
  });
  it('round trips received public key through actual encryption and private registry materialization', async () => {
    const publicKey = await receivePreviewFixturePublicKey(transfer());
    const users = Object.fromEntries(
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
    );
    const payload = { schemaVersion: 1, operation: 'provision', runId: input.intent.runId, users };
    const envelope = encryptPreviewFixtureEnvelope({ input, publicKey, payload });
    const runnerTemp = mkdtempSync(join(tmpdir(), 'public-key-handoff-test-'));
    const privateOutput = join(runnerTemp, 'browser');
    const evidenceDirectory = join(runnerTemp, 'evidence');
    mkdirSync(privateOutput);
    mkdirSync(evidenceDirectory);
    try {
      const result = await receivePreviewFixtureRegistry({
        ...transfer(envelope, 'envelope'),
        privateKey: pair.privateKey,
        runnerTemp,
        privateOutput,
        evidenceDirectory,
      });
      expect(JSON.parse(readFileSync(result.path, 'utf8')).users).toEqual(users);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});
