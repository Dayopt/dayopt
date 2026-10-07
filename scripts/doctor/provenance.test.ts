import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractFingerprint } from './provenance.ts';

describe('contract provenance', () => {
  it('tracks changes in referenced contracts even if expected.yaml and HEAD are unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-contract-'));
    try {
      mkdirSync(join(root, 'contracts'));
      writeFileSync(join(root, 'contracts/a.ts'), 'contract A');
      writeFileSync(join(root, 'contracts/b.ts'), 'contract B');
      const before = contractFingerprint(root, { auth: ['contracts'] });
      expect(before).toMatch(/^[a-f0-9]{64}$/);
      expect(contractFingerprint(root, { auth: ['contracts/b.ts', 'contracts/a.ts'] })).toBe(
        before,
      );
      writeFileSync(join(root, 'contracts/a.ts'), 'changed A');
      expect(contractFingerprint(root, { auth: ['contracts'] })).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects environment files, external paths and symlinks instead of hashing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-contract-'));
    try {
      writeFileSync(join(root, 'safe.ts'), 'safe contract');
      symlinkSync(join(root, 'safe.ts'), join(root, 'link.ts'));
      mkdirSync(join(root, 'contracts'));
      writeFileSync(join(root, 'contracts/safe.ts'), 'safe');
      symlinkSync(join(root, 'contracts'), join(root, 'linked-directory'));
      expect(() => contractFingerprint(root, { env: ['.env.local'] })).toThrow(
        'private_contract_path',
      );
      expect(() => contractFingerprint(root, { env: ['../outside'] })).toThrow(
        'invalid_contract_path',
      );
      expect(() => contractFingerprint(root, { env: ['link.ts'] })).toThrow(
        'symlink_contract_path',
      );
      expect(() => contractFingerprint(root, { env: ['linked-directory/safe.ts'] })).toThrow(
        'symlink_contract_path',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
