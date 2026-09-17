import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('does not treat invalid metadata as applied', async () => {
    await expect(
      checkMigrationReadiness({ token: 't', root, query: async () => [{ version: null }] }),
    ).rejects.toThrow('Invalid migration metadata');
  });
});
