import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(import.meta.dirname, '../tasks/check-client-bundle-secrets.mjs'),
);

function scan(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-bundle-keys-'));
  try {
    mkdirSync(join(root, 'scripts/tasks'), { recursive: true });
    mkdirSync(join(root, 'apps/product/.next/static/chunks'), { recursive: true });
    const script = join(root, 'scripts/tasks/check-client-bundle-secrets.mjs');
    writeFileSync(script, source);
    writeFileSync(join(root, 'apps/product/.next/static/chunks/sdk.js'), content);
    return spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('client bundle secret inspection', () => {
  it('allows the actual SDK key-prefix discriminator', () => {
    const sdkPath = execFileSync(
      process.execPath,
      ['-p', "require.resolve('@supabase/supabase-js')"],
      {
        cwd: resolve(import.meta.dirname, '../../apps/product'),
        encoding: 'utf8',
      },
    ).trim();
    const sdk = readFileSync(sdkPath, 'utf8');
    expect(sdk).toContain('sb_secret_');
    expect(scan(sdk).status).toBe(0);
  });

  it('still detects a secret literal in a chunk containing the SDK discriminator', () => {
    const secret = ['sb', 'secret', 'a'.repeat(40)].join('_');
    const result = scan(`key.startsWith('sb_secret_');const leaked=${JSON.stringify(secret)};`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Supabase secret key literal');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });

  it.each(['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'])(
    'rejects server env reference %s',
    (name) => {
      const result = scan(`process.env.${name}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(name);
    },
  );
});
