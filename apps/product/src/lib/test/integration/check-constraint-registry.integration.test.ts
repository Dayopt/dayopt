/** #3092: 値を列挙する CHECK 制約と、TS の登録表が一致する。 */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  diffCheckConstraintRegistry,
  type CheckConstraintRow,
} from '@/lib/test/check-constraint-registry-diff';

import { CHECK_CONSTRAINT_REGISTRY } from './check-constraint-registry';

function runOwnerSql(sql: string): string {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-F',
      '\t',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { encoding: 'utf8', input: sql, env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  if (result.error || result.status !== 0) {
    throw new Error('CHECK registry integration requires psql and the isolated local database');
  }
  return result.stdout.trim();
}

function readEnumeratedCheckConstraints(): CheckConstraintRow[] {
  const output = runOwnerSql(`
    SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'c'
      AND n.nspname IN ('public', 'private')
      AND pg_get_constraintdef(con.oid) LIKE '%ARRAY[%'
    ORDER BY 1, 2, 3;
  `);
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [schema = '', table = '', name = '', definition = ''] = line.split('\t');
      return { schema, table, name, definition };
    });
}

// This suite is local-only; the integration runner rejects a silently skipped file.
describe.skipIf(process.env.USE_LOCAL_DB !== 'true')('CHECK constraint registry (#3092)', () => {
  it('値を列挙する全 CHECK が登録表と一致する', () => {
    const rows = readEnumeratedCheckConstraints();
    expect(rows.length).toBeGreaterThan(0);
    expect(diffCheckConstraintRegistry(rows, CHECK_CONSTRAINT_REGISTRY)).toEqual([]);
  });
});
