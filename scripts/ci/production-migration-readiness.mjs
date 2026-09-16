#!/usr/bin/env node
/**
 * 公開前の migration 反映確認（#2797）。promote.yml の release job で、候補 SHA の repo
 * migration 集合が production の `supabase_migrations.schema_migrations` に全て入っているかを
 * 許可済み read-only Management API で確認する。
 *
 * - migration の writer は Supabase GitHub integration のまま。ここは読むだけで、適用・再試行・
 *   rollback は行わない
 * - token（`SUPABASE_MIGRATION_READINESS_TOKEN`、database_read だけの scoped token）が無い環境では
 *   **advisory**: 未確認である旨を warning と出力に残して exit 0。promote.yml はまだ token を渡して
 *   いない。有効化は User 裁可の別変更（secret を production-release environment へ置き、台帳・
 *   同期 script・ledger test を更新）で、置いた時点から欠落は promote を止める
 * - 候補に migration が無い（live と同じ集合）場合も同じ比較で通る。差分計算に live SHA は
 *   要らない: 「候補が期待する集合 ⊆ production に適用済み」だけを見る
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { runReadOnlyQuery } from '../lib/production-db-readonly.mjs';
import { compareMigrationVersions } from './production-schema-drift-audit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function expectedMigrationVersions(root = ROOT) {
  return readdirSync(resolve(root, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
}

/**
 * @returns {Promise<{ status: 'verified' | 'missing' | 'unverified', missing: string[], detail: string }>}
 */
export async function checkMigrationReadiness({
  token = process.env.SUPABASE_MIGRATION_READINESS_TOKEN,
  query = runReadOnlyQuery,
  root = ROOT,
} = {}) {
  const expected = expectedMigrationVersions(root);
  if (expected.length === 0) throw new Error('Repository migration list is empty');
  if (!token?.trim())
    return {
      status: 'unverified',
      missing: [],
      detail:
        'SUPABASE_MIGRATION_READINESS_TOKEN is not available in this environment; migration state was not verified',
    };
  const rows = await query(
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    { token },
  );
  const { missing } = compareMigrationVersions(expected, rows);
  if (missing.length)
    return {
      status: 'missing',
      missing,
      detail: `Production has not applied: ${missing.join(', ')}`,
    };
  return {
    status: 'verified',
    missing: [],
    detail: `${expected.length} migration version(s) present in production`,
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = await checkMigrationReadiness();
    if (result.status === 'missing') {
      console.error(`::error::Migration readiness: ${result.detail}`);
      process.exitCode = 1;
    } else if (result.status === 'unverified') {
      console.log(`::warning::Migration readiness: ${result.detail}`);
    } else console.log(`Migration readiness verified: ${result.detail}`);
  } catch (error) {
    console.error(
      `::error::Migration readiness could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
