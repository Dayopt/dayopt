import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptPreviewFixtureEnvelope,
  encryptPreviewFixtureEnvelope,
  generatePreviewFixtureKeyPair,
} from './preview-fixture-envelope.mjs';

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
const payload = {
  schemaVersion: 1,
  runId: input.intent.runId,
  operation: 'provision',
  users: {
    desktop: { email: 'synthetic@example.com', password: 'PRIVATE_LOGIN_PASSWORD' },
    mobile: { password: 'PRIVATE_MOBILE_PASSWORD' },
  },
};
const recipient = generatePreviewFixtureKeyPair();
const other = generatePreviewFixtureKeyPair();
const envelope = encryptPreviewFixtureEnvelope({ input, publicKey: recipient.publicKey, payload });
const invalid = /^Preview fixture envelope is invalid$/;
function decrypt(selected = envelope, selectedInput = input, key = recipient.privateKey) {
  return decryptPreviewFixtureEnvelope({
    input: selectedInput,
    privateKey: key,
    envelope: selected,
  });
}
function flip(value: string) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

describe('private Preview fixture encryption without transport or sender authentication', () => {
  it('rejects malformed call options using the same fixed error', () => {
    for (const value of [undefined, null, [], {}, { input, publicKey: recipient.publicKey }])
      expect(() => encryptPreviewFixtureEnvelope(value)).toThrow(invalid);
    for (const value of [undefined, null, [], {}, { input, privateKey: recipient.privateKey }])
      expect(() => decryptPreviewFixtureEnvelope(value)).toThrow(invalid);
    expect(() =>
      encryptPreviewFixtureEnvelope({
        input,
        publicKey: recipient.publicKey,
        payload,
        extra: 'PRIVATE_PROVIDER_BODY',
      }),
    ).toThrow(invalid);
  });
  it('round trips actual RSA/GCM encryption with a public provision binding', () => {
    expect(recipient.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    // This is a PEM header assertion, not an embedded private key.
    expect(recipient.privateKey.startsWith(['-----BEGIN', 'PRIVATE KEY-----'].join(' '))).toBe(
      true,
    );
    expect(envelope.binding.authority.intent).toEqual(input.intent);
    expect(envelope.binding.publicKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(decrypt(JSON.parse(JSON.stringify(envelope)))).toEqual(payload);
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_LOGIN_PASSWORD');
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_MOBILE_PASSWORD');
    expect(JSON.stringify(envelope)).not.toContain(recipient.privateKey);
  });
  it('uses fresh AES keys/nonces and RSA padding for repeated identical payloads', () => {
    const second = encryptPreviewFixtureEnvelope({
      input,
      publicKey: recipient.publicKey,
      payload,
    });
    expect(second.nonce).not.toBe(envelope.nonce);
    expect(second.wrappedKey).not.toBe(envelope.wrappedKey);
    expect(second.ciphertext).not.toBe(envelope.ciphertext);
    expect(decrypt(second)).toEqual(payload);
  });
  it('rejects another recipient even if the public recipient digest is rewritten', () => {
    expect(() => decrypt(envelope, input, other.privateKey)).toThrow(invalid);
    const rewritten = structuredClone(envelope);
    rewritten.binding.publicKeyDigest = encryptPreviewFixtureEnvelope({
      input,
      publicKey: other.publicKey,
      payload,
    }).binding.publicKeyDigest;
    expect(() => decrypt(rewritten, input, other.privateKey)).toThrow(invalid);
  });
  it.each(['wrappedKey', 'nonce', 'ciphertext', 'tag'] as const)('rejects tampered %s', (field) => {
    expect(() => decrypt({ ...envelope, [field]: flip(envelope[field]) })).toThrow(invalid);
  });
  it.each(['wrappedKey', 'nonce', 'ciphertext', 'tag'] as const)(
    'rejects truncation, padding, invalid alphabet and empty %s',
    (field) => {
      for (const value of [
        envelope[field].slice(0, -1),
        `${envelope[field]}=`,
        'PRIVATE+/body',
        '',
      ])
        expect(() => decrypt({ ...envelope, [field]: value })).toThrow(invalid);
    },
  );
  it.each(['run', 'attempt', 'intent', 'origin', 'deployment', 'db', 'workflow'])(
    'rejects a different %s binding',
    (changed) => {
      const selected = structuredClone(input);
      if (changed === 'run') selected.intent.runId = '44444444-4444-4444-8444-444444444444';
      if (changed === 'attempt') {
        selected.execution.attempt = 2;
        selected.intent.sourceAttempt = 2;
      }
      if (changed === 'intent')
        selected.intent.userIds.mobile = '44444444-4444-4444-8444-444444444444';
      if (changed === 'origin') selected.origin = 'https://product-other123-dayopt.vercel.app';
      if (changed === 'deployment') selected.intent.request.deploymentId = 'dpl_other123';
      if (changed === 'db') selected.intent.request.supabaseProjectRef = 'bcdefghijklmnopqrstu';
      if (changed === 'workflow') {
        selected.execution.workflowSha = 'c'.repeat(40);
        selected.intent.workflowSha = selected.execution.workflowSha;
      }
      expect(() => decrypt(envelope, selected)).toThrow(invalid);
    },
  );
  it('authenticates binding bytes even when caller and envelope are changed together', () => {
    const selected = structuredClone(input);
    selected.origin = 'https://product-other123-dayopt.vercel.app';
    const rewritten = structuredClone(envelope);
    const generated = encryptPreviewFixtureEnvelope({
      input: selected,
      publicKey: recipient.publicKey,
      payload,
    });
    rewritten.binding = generated.binding;
    expect(() => decrypt(rewritten, selected)).toThrow(invalid);
  });
  it('accepts canonical bindings despite JSON key reordering', () => {
    const reordered = structuredClone(envelope);
    reordered.binding.authority.intent.userIds = {
      mobile: input.intent.userIds.mobile,
      desktop: input.intent.userIds.desktop,
    };
    expect(decrypt(reordered)).toEqual(payload);
  });
  it('rejects unknown fields, bad schema, malformed binding and oversized bodies', () => {
    for (const malformed of [
      null,
      [],
      { ...envelope, extra: 'PRIVATE_PROVIDER_BODY' },
      { ...envelope, schemaVersion: 2 },
      { ...envelope, binding: { ...envelope.binding, extra: true } },
      { ...envelope, binding: { ...envelope.binding, authority: null } },
      {
        ...envelope,
        binding: { ...envelope.binding, authority: { ...envelope.binding.authority, extra: true } },
      },
      { ...envelope, ciphertext: 'a'.repeat(50_000) },
      { ...envelope, tag: 'a'.repeat(24) },
    ])
      expect(() => decrypt(malformed as typeof envelope)).toThrow(invalid);
  });
  it('bounds JSON plaintext, rejects cycles/undefined, and permits the maximum payload', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [undefined, cycle, 'x'.repeat(16_383), { secret: 'x'.repeat(17_000) }])
      expect(() =>
        encryptPreviewFixtureEnvelope({ input, publicKey: recipient.publicKey, payload: value }),
      ).toThrow(invalid);
    const maximum = 'x'.repeat(16_382);
    expect(
      decrypt(
        encryptPreviewFixtureEnvelope({ input, publicKey: recipient.publicKey, payload: maximum }),
      ),
    ).toBe(maximum);
  });
  it('rejects weak or non-RSA keys, private keys in public inputs, and malformed PEM', () => {
    const weak = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    for (const publicKey of [
      weak.publicKey,
      ec.publicKey,
      recipient.privateKey,
      'PRIVATE_PROVIDER_BODY',
      'x'.repeat(2049),
    ])
      expect(() => encryptPreviewFixtureEnvelope({ input, publicKey, payload })).toThrow(invalid);
    for (const privateKey of [
      weak.privateKey,
      ec.privateKey,
      recipient.publicKey,
      'PRIVATE_PROVIDER_BODY',
      'x'.repeat(8193),
    ])
      expect(() => decrypt(envelope, input, privateKey)).toThrow(invalid);
  });
  it('rejects cleanup/recover input rather than minting another kind of credential envelope', () => {
    for (const operation of ['cleanup', 'recover']) {
      const selected = {
        ...input,
        operation,
        execution: { ...input.execution, attempt: operation === 'recover' ? 2 : 1 },
      };
      expect(() =>
        encryptPreviewFixtureEnvelope({ input: selected, publicKey: recipient.publicKey, payload }),
      ).toThrow(invalid);
      expect(() => decrypt(envelope, selected)).toThrow(invalid);
    }
  });
  it('does not claim sender authentication: another party with the public key can encrypt', () => {
    const untrusted = { message: 'writer must reject this non-registry payload' };
    const forged = encryptPreviewFixtureEnvelope({
      input,
      publicKey: recipient.publicKey,
      payload: untrusted,
    });
    expect(decrypt(forged)).toEqual(untrusted);
  });
});
