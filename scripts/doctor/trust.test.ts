import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('does not authenticate from an untrusted checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-untrusted-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const marker = join(root, 'op-called');
  writeFileSync(join(bin, 'op'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/doctor/cli.ts', '--service', 'github'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCTOR_TRUSTED_REVISION: '' },
        timeout: 10000,
      },
    );
  } catch (error) {
    output = String((error as { stdout?: string }).stdout ?? '');
  }
  expect(output).toContain('trusted_runtime_required');
  expect(existsSync(marker)).toBe(false);
});
