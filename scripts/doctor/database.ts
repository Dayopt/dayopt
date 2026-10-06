import { execFile, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateHeartbeats } from '../../apps/product/src/lib/ops/cron-heartbeat-policy.mjs';
import type { Observation, ReaderContext } from './types.ts';

/** Reuse metadata comparators; never impose an unshipped repository contract on live. */
export async function databaseChecks(
  ctx: ReaderContext,
  observations: Observation[],
): Promise<Observation[]> {
  if (!['all', 'production'].includes(ctx.environment)) return [];
  const { compareMigrationVersions } = await import('../ci/production-schema-drift-audit.mjs');
  const source = 'schema/cron source contracts + fixed metadata + public.health';
  const keys = ['migrations', 'heartbeats', 'schema_snapshot'];
  const base = (name: string): Observation => ({
    key: `supabase.production.${name}`,
    environment: 'production',
    source,
    value: null,
  });
  let deployed: unknown;
  let repo: string;
  try {
    deployed = await ctx.request('public.health', { target: 'production' });
    repo = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ctx.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return keys.map((name) => ({
      ...base(name),
      status: 'blocked',
      reason: 'deployed_revision_unavailable',
    }));
  }
  const sha = (deployed as { commitSha?: string })?.commitSha;
  let sameContract = false;
  if (sha && /^[a-f0-9]{7,40}$/i.test(sha)) {
    const paths = [
      'supabase/migrations',
      'docs/engineering/data/db/rls-snapshot.md',
      'apps/product/src/lib/ops/cron-heartbeat-policy.mjs',
      'apps/product/src/lib/ops/cron-heartbeat.ts',
      'apps/product/src/app/api/cron/billing-reconciliation/route.ts',
      'apps/product/src/app/api/health/cron/route.ts',
      'scripts/tasks/generate-rls-snapshot.ts',
    ];
    try {
      execFileSync('git', ['diff', '--quiet', sha, '--', ...paths], {
        cwd: ctx.root,
        stdio: 'ignore',
      });
      sameContract =
        execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...paths], {
          cwd: ctx.root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === '';
    } catch {
      /* The served commit may not exist locally, or its contract differs. */
    }
  }
  if (!sameContract)
    return keys.map((name) => ({
      ...base(name),
      value: {
        repo_revision: repo,
        deployed_revision: sha && /^[a-f0-9]{7,40}$/i.test(sha) ? sha : null,
      },
      status: 'manual',
      reason: 'repository_contract_not_verified_as_deployed',
      next_step:
        '配信SHAの契約で比較してください。未配信のmigrationやheartbeatを適用済みとは扱いません。',
    }));
  const metadata = observations.find((row) => row.key === 'supabase.production.database_metadata');
  const row = Array.isArray(metadata?.value)
    ? (metadata.value[0] as Record<string, unknown>)
    : undefined;
  const output: Observation[] = [];
  for (const name of ['migrations', 'heartbeats']) {
    try {
      if (!row || metadata?.status) throw new Error();
      const differences =
        name === 'migrations'
          ? compareMigrationVersions(
              readdirSync(resolve(ctx.root, 'supabase/migrations'))
                .filter((file) => /^\d{14}_.+\.sql$/.test(file))
                .map((file) => file.slice(0, 14)),
              Array.isArray(row.migration_versions)
                ? row.migration_versions.map((version) => ({ version }))
                : null,
            )
          : { failures: evaluateHeartbeats(Array.isArray(row.heartbeats) ? row.heartbeats : []) };
      const failed =
        'missing' in differences ? differences.missing.length > 0 : differences.failures.length > 0;
      output.push({ ...base(name), value: { passed: !failed, ...differences } });
    } catch {
      output.push({ ...base(name), status: 'blocked', reason: 'database_metadata_unavailable' });
    }
  }
  // Existing snapshot generator is invoked ONLY in its check-only, management API mode.
  output.push(
    await new Promise<Observation>((done) => {
      execFile(
        process.execPath,
        [
          resolve(ctx.root, 'node_modules/tsx/dist/cli.mjs'),
          resolve(ctx.root, 'scripts/tasks/generate-rls-snapshot.ts'),
          '--check',
        ],
        {
          cwd: ctx.root,
          timeout: 45_000,
          maxBuffer: 1_000_000,
          env: {
            ...process.env,
            RLS_SNAPSHOT_TRANSPORT: 'management-api',
            SUPABASE_STORAGE_RLS_AUDIT_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
          },
        },
        (error) => {
          if (!error) done({ ...base('schema_snapshot'), value: { passed: true } });
          else if (error.code === 1 && !error.killed)
            done({ ...base('schema_snapshot'), value: { passed: false } });
          else
            done({
              ...base('schema_snapshot'),
              status: 'blocked',
              reason: 'schema_snapshot_read_or_timeout_failed',
            });
        },
      );
    }),
  );
  return output;
}
