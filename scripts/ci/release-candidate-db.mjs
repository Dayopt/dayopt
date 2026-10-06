import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

export function recordCandidateDb({
  root,
  runId,
  attempt,
  exec = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim(),
}) {
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt))
    throw new Error('Invalid candidate attempt');
  const status = JSON.parse(exec('supabase', ['status', '--output', 'json']));
  const endpoint = new URL(status.DB_URL);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname))
    throw new Error('Candidate DB must be disposable runner Supabase');
  const containers = exec('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.ID}}'])
    .split('\n')
    .filter(Boolean);
  if (containers.length !== 1 || !/^[0-9a-f]+$/.test(containers[0]))
    throw new Error('Candidate DB container is ambiguous');
  const container = containers[0];
  const rows = JSON.parse(
    exec('docker', [
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-c',
      "SELECT coalesce(json_agg(version ORDER BY version), '[]') FROM supabase_migrations.schema_migrations",
    ]),
  );
  const files = readdirSync(resolve(root, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort();
  const expected = files.map((name) => name.slice(0, 14));
  if (!expected.length || JSON.stringify(rows) !== JSON.stringify(expected))
    throw new Error('Candidate DB migration set differs from repository');
  const migrationHash = createHash('sha256');
  for (const name of files)
    migrationHash
      .update(name)
      .update('\0')
      .update(readFileSync(resolve(root, 'supabase/migrations', name)))
      .update('\0');
  const dump = exec('docker', [
    'exec',
    container,
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    '--schema=public',
    '--schema=private',
    '--schema=auth',
    '--schema=storage',
  ]);
  // pg_dump 17+ emits a random restrict nonce; discard only those meta commands.
  const schema = dump.replace(/^\\(?:un)?restrict .*$/gm, '');
  return {
    identity: `runner:${container}:${runId}:${attempt}`,
    migrationHash: migrationHash.digest('hex'),
    schemaHash: createHash('sha256').update(schema).digest('hex'),
    observedAt: new Date().toISOString(),
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = recordCandidateDb({
      root: resolve(process.argv[2]),
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate DB evidence failed');
    process.exitCode = 1;
  }
}
