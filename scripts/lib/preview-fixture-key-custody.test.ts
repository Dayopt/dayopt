import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptPreviewFixtureEnvelope,
  encryptPreviewFixtureEnvelope,
} from './preview-fixture-envelope.mjs';
import {
  preparePreviewFixtureKeyCustody,
  withPreviewFixturePrivateKey,
} from './preview-fixture-key-custody.mjs';
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

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup() {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'key-custody-test-'));
  directories.push(runnerTemp);
  const privateOutput = join(runnerTemp, 'browser');
  const evidenceDirectory = join(runnerTemp, 'evidence');
  mkdirSync(privateOutput);
  mkdirSync(evidenceDirectory);
  const args = { input: structuredClone(input), runnerTemp, privateOutput, evidenceDirectory };
  const paths = preparePreviewFixtureKeyCustody(args);
  return { args, ...paths };
}
const invalid = /^Preview fixture key custody failed$/;
describe('one-time private key custody before candidate checkout', () => {
  it('separates public artifact from mode 600 private key in a mode 700 directory', () => {
    const s = setup();
    expect(statSync(s.privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(s.privatePath)).mode & 0o777).toBe(0o700);
    expect(dirname(s.privatePath)).not.toBe(s.publicDirectory);
    expect(readdirSync(s.publicDirectory)).toEqual(['public-key.json']);
    const body = readFileSync(s.publicPath, 'utf8');
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).not.toContain(readFileSync(s.privatePath, 'utf8'));
  });
  it('uses actual PEM to decrypt, then removes private file and directory while retaining public artifact', async () => {
    const s = setup();
    const publicKey = JSON.parse(readFileSync(s.publicPath, 'utf8')).publicKey;
    const envelope = encryptPreviewFixtureEnvelope({ input, publicKey, payload: { ok: true } });
    const result = await withPreviewFixturePrivateKey({
      ...s.args,
      privatePath: s.privatePath,
      use: async (privateKey: string) => {
        expect(existsSync(s.privatePath)).toBe(true);
        return decryptPreviewFixtureEnvelope({ input, privateKey, envelope });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(dirname(s.privatePath))).toBe(false);
    expect(existsSync(s.publicPath)).toBe(true);
  });
  it('cleans private files when the callback fails and hides its error', async () => {
    const s = setup();
    await expect(
      withPreviewFixturePrivateKey({
        ...s.args,
        privatePath: s.privatePath,
        use: async () => {
          throw new Error('PRIVATE_PEM_OR_RESPONSE');
        },
      }),
    ).rejects.toThrow(invalid);
    expect(existsSync(dirname(s.privatePath))).toBe(false);
  });
  it('rejects malformed stored PEM and removes the owned private file', async () => {
    const s = setup();
    writeFileSync(s.privatePath, 'not a key');
    const use = vi.fn();
    await expect(
      withPreviewFixturePrivateKey({ ...s.args, privatePath: s.privatePath, use }),
    ).rejects.toThrow(invalid);
    expect(use).not.toHaveBeenCalled();
    expect(existsSync(dirname(s.privatePath))).toBe(false);
  });
  it('fails cleanup without recursively deleting unknown entries', async () => {
    const s = setup();
    const unknown = join(dirname(s.privatePath), 'unknown');
    await expect(
      withPreviewFixturePrivateKey({
        ...s.args,
        privatePath: s.privatePath,
        use: async () => {
          writeFileSync(unknown, 'retain');
          return 'success';
        },
      }),
    ).rejects.toThrow(invalid);
    expect(readFileSync(unknown, 'utf8')).toBe('retain');
    expect(existsSync(s.privatePath)).toBe(false);
  });
  it.each([
    'relative',
    'wrong-run',
    'mode',
    'directory-mode',
    'symlink',
    'directory-alias',
    'hardlink',
    'output-alias',
  ])('rejects %s without invoking callback or deleting unvalidated input', async (mode) => {
    const s = setup();
    let privatePath = s.privatePath;
    if (mode === 'relative') privatePath = 'private.pem';
    if (mode === 'wrong-run') s.args.input.origin = 'https://product-other123-dayopt.vercel.app';
    if (mode === 'mode') chmodSync(privatePath, 0o644);
    if (mode === 'directory-mode') chmodSync(dirname(privatePath), 0o755);
    if (mode === 'symlink') {
      const target = join(s.args.runnerTemp, 'target');
      writeFileSync(target, 'preserve');
      unlinkSync(privatePath);
      symlinkSync(target, privatePath);
    }
    if (mode === 'directory-alias') {
      const alias = join(s.args.runnerTemp, 'alias');
      symlinkSync(dirname(privatePath), alias);
      privatePath = join(alias, 'private.pem');
    }
    if (mode === 'hardlink') linkSync(privatePath, join(s.args.runnerTemp, 'hardlink'));
    if (mode === 'output-alias') {
      const alias = join(s.args.runnerTemp, 'output-alias');
      symlinkSync(dirname(privatePath), alias);
      s.args.privateOutput = alias;
    }
    const use = vi.fn();
    await expect(withPreviewFixturePrivateKey({ ...s.args, privatePath, use })).rejects.toThrow(
      invalid,
    );
    expect(use).not.toHaveBeenCalled();
    expect(existsSync(s.privatePath)).toBe(true);
  });
  it('rejects creation inside an output directory including its symlink alias', () => {
    const s = setup();
    const alias = join(s.args.runnerTemp, 'output-link');
    symlinkSync(s.args.privateOutput, alias);
    expect(() => preparePreviewFixtureKeyCustody({ ...s.args, runnerTemp: alias })).toThrow(
      invalid,
    );
    expect(readdirSync(s.args.privateOutput)).toEqual([]);
  });
});
