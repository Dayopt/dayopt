import { execFile, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { JOB_MAX_AGE_MINUTES } from '../../apps/product/src/lib/ops/cron-heartbeat-policy.mjs';
import { databaseChecks } from './database.ts';
const contractFixture = vi.hoisted(() => ({ matches: false }));
beforeEach(() => {
  contractFixture.matches = false;
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: unknown[]) => {
      if (contractFixture.matches && Array.isArray(args[1]) && args[1][0] === 'diff') return '';
      return Reflect.apply(actual.execFileSync, undefined, args);
    }),
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, 'mock-secret-body', 'mock-secret-error');
    }),
  };
});
it('does not impose unshipped schema or cron contracts or run a snapshot check', async () => {
  const request = vi.fn().mockResolvedValue({ commitSha: 'aaaaaaaa' });
  const rows = await databaseChecks(
    { root: process.cwd(), environment: 'production', request },
    [],
  );
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.status === 'manual')).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});
it('reports missing revision evidence as blocked', async () => {
  const rows = await databaseChecks(
    {
      root: process.cwd(),
      environment: 'production',
      request: async () => {
        throw new Error('fixture-secret');
      },
    },
    [],
  );
  expect(rows.every((row) => row.status === 'blocked')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('fixture-secret');
});
it('does not use production SQL or snapshot for Integration or Preview', async () => {
  const request = vi.fn();
  for (const environment of ['integration', 'preview'] as const)
    expect(await databaseChecks({ root: process.cwd(), environment, request }, [])).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});

it('reuses migration and heartbeat contracts and invokes only check-only API snapshot', async () => {
  // Model a served contract matching the working tree independently of local edits.
  contractFixture.matches = true;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const versions = readdirSync('supabase/migrations')
    .filter((file) => /^\d{14}_.+\.sql$/.test(file))
    .map((file) => file.slice(0, 14));
  const healthy = Object.keys(JOB_MAX_AGE_MINUTES).map((job_name) => ({
    job_name,
    last_completed_at: new Date().toISOString(),
  }));
  const ctx = {
    root: process.cwd(),
    environment: 'production' as const,
    request: async () => ({ commitSha: sha }),
  };
  const observations = [
    {
      key: 'supabase.production.database_metadata',
      environment: 'production',
      source: 'fixture',
      value: [{ migration_versions: versions, heartbeats: healthy }],
    },
  ];
  const rows = await databaseChecks(ctx, observations);
  expect(rows.every((row) => (row.value as { passed: boolean }).passed === true)).toBe(true);
  expect(execFileSync).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining([
      'apps/product/src/lib/ops/cron-heartbeat.ts',
      'apps/product/src/app/api/cron/billing-reconciliation/route.ts',
    ]),
    expect.any(Object),
  );
  expect(execFile).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(['--check']),
    expect.objectContaining({
      timeout: 45000,
      env: expect.objectContaining({ RLS_SNAPSHOT_TRANSPORT: 'management-api' }),
    }),
    expect.any(Function),
  );
  expect(JSON.stringify(rows)).not.toContain('mock-secret');
  const bad = await databaseChecks(ctx, [
    { ...observations[0], value: [{ migration_versions: [], heartbeats: [] }] },
  ]);
  expect(bad.slice(0, 2).every((row) => (row.value as { passed: boolean }).passed === false)).toBe(
    true,
  );
});
