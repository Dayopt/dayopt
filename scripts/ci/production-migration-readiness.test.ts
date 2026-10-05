import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkMigrationReadiness,
  expectedMigrationVersions,
} from './production-migration-readiness.mjs';

const root = mkdtempSync(join(tmpdir(), 'migration-readiness-'));
mkdirSync(join(root, 'supabase/migrations/_archive'), { recursive: true });
for (const name of [
  '00000000000000_baseline.sql',
  '20260916010000_welcome.sql',
  '20260917000000_new.sql',
])
  writeFileSync(join(root, 'supabase/migrations', name), 'select 1;\n');
writeFileSync(join(root, 'supabase/migrations/README.md'), 'not a migration\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const applied = (versions: string[]) => async () => versions.map((version) => ({ version }));
const scriptPath = fileURLToPath(new URL('./production-migration-readiness.mjs', import.meta.url));

describe('production migration readiness', () => {
  it('reads the candidate migration versions from the repository', () => {
    expect(expectedMigrationVersions(root)).toEqual([
      '00000000000000',
      '20260916010000',
      '20260917000000',
    ]);
  });

  it('verifies when production already applied every candidate version', async () => {
    const result = await checkMigrationReadiness({
      token: 't',
      root,
      query: applied(['00000000000000', '20260916010000', '20260917000000', '20260918000000']),
    });
    expect(result.status).toBe('verified');
  });

  it('reports missing versions after a bounded wait instead of applying them', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const result = await checkMigrationReadiness({
      token: 't',
      root,
      attempts: 3,
      intervalMs: 5,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      query: async (sql: string) => {
        calls.push(sql);
        return [{ version: '00000000000000' }, { version: '20260916010000' }];
      },
    });
    expect(result.status).toBe('missing');
    expect(result.missing).toEqual(['20260917000000']);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5, 5]);
    expect(calls[0]).toMatch(/^SELECT version FROM supabase_migrations\.schema_migrations/);
  });

  it('verifies as soon as the asynchronous integration catches up', async () => {
    let reads = 0;
    const result = await checkMigrationReadiness({
      token: 't',
      root,
      attempts: 4,
      sleep: async () => {},
      query: async () => {
        reads += 1;
        return reads < 2
          ? [{ version: '00000000000000' }]
          : [
              { version: '00000000000000' },
              { version: '20260916010000' },
              { version: '20260917000000' },
            ];
      },
    });
    expect(result.status).toBe('verified');
    expect(result.attempts).toBe(2);
  });

  it('is advisory (unverified, no query) while the token is absent', async () => {
    let queried = false;
    const result = await checkMigrationReadiness({
      token: '',
      root,
      query: async () => {
        queried = true;
        return [];
      },
    });
    expect(result.status).toBe('unverified');
    expect(queried).toBe(false);
  });

  it('fails the CLI when candidate mode requires evidence but the token is missing', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MIGRATION_READINESS_REQUIRED: 'true',
        SUPABASE_MIGRATION_READINESS_TOKEN: '',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Migration readiness:');
    expect(result.stderr).toContain('migration state was not verified');
    expect(result.stdout).not.toContain('Migration readiness verified:');
  });

  it('keeps missing migration evidence advisory when candidate mode is disabled', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MIGRATION_READINESS_REQUIRED: '',
        SUPABASE_MIGRATION_READINESS_TOKEN: '',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::Migration readiness:');
    expect(result.stderr).not.toContain('::error::Migration readiness:');
  });

  it('does not treat invalid metadata as applied', async () => {
    await expect(
      checkMigrationReadiness({ token: 't', root, query: async () => [{ version: null }] }),
    ).rejects.toThrow('Invalid migration metadata');
  });
});
