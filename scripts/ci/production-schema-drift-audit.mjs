import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runReadOnlyQuery } from '../lib/production-db-readonly.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function compareMigrationVersions(expected, rows) {
  if (
    !Array.isArray(rows) ||
    rows.some((row) => typeof row?.version !== 'string' || !/^\d{14}$/.test(row.version))
  ) {
    throw new Error('Invalid migration metadata');
  }
  const actual = new Set(rows.map((row) => row.version));
  return {
    missing: expected.filter((version) => !actual.has(version)),
    extra: [...actual].filter((version) => !expected.includes(version)),
  };
}

export async function auditSchema({
  query = runReadOnlyQuery,
  execute = spawnSync,
  root = ROOT,
} = {}) {
  const expected = readdirSync(resolve(root, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
  if (expected.length === 0) throw new Error('Repository migration list is empty');
  const versions = compareMigrationVersions(
    expected,
    await query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version'),
  );
  if (versions.missing.length)
    throw new Error(`Unapplied migrations: ${versions.missing.join(', ')}`);
  if (versions.extra.length)
    console.log(`::notice::Production-only migration versions: ${versions.extra.join(', ')}`);
  // Reuse exactly the local snapshot queries and renderer. Never regenerate the trusted baseline from production.
  const result = execute(
    'pnpm',
    ['exec', 'tsx', 'scripts/tasks/generate-rls-snapshot.ts', '--check'],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, RLS_SNAPSHOT_TRANSPORT: 'management-api' },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Production schema/ACL snapshot differs or could not be read');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    await auditSchema();
    console.log('Production Schema Drift Audit passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Schema drift audit failed');
    process.exitCode = 1;
  }
}
