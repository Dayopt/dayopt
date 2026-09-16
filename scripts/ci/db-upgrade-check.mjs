#!/usr/bin/env node
/**
 * DB upgrade / old-consumer check（#2797）。ci.yml の `🧱 DB Upgrade (shadow)` job から実行する。
 *
 * integration job の `supabase start` は candidate の migration 集合を空 DB へ適用する
 * **fresh 経路**しか証明しない。ここでは次を別々に証明する:
 *
 * 1. upgrade: base（PR の merge 元）の migration 集合 + seed（合成データ）まで reset し、
 *    PR が追加した migration だけを `migration up --include-all` で当てる。適用エラー、
 *    seed 行の消失（既存データ保持）、fresh と upgraded の schema 不一致（`gen types` の差）を落とす
 * 2. old consumer: base 世代の生成型（`database.types.ts`）が参照する table / column / view /
 *    function / enum 値が upgraded DB から消えていれば「旧アプリ × 新 DB」の互換性が
 *    壊れる候補として落とす（expand → migrate → contract の contract 段は明示承認の対象）
 * 3. 適用済み migration の編集・削除は production が再実行しないため落とす
 *
 * PR が migration を追加していなければ skip（exit 0）。fresh 成功を upgrade 成功の代用にしない。
 * 接続先はローカル Docker の Supabase だけ（production / linked には触れない）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TYPES_PATH = 'apps/product/src/lib/database/generated/database.types.ts';
export const MIGRATIONS_DIR = 'supabase/migrations';
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
export const DB_UPGRADE_JOB = '🧱 DB Upgrade (shadow)';

/** `information_schema` の全 base table の行数（public / auth）。psql `-At -F,` で読む。 */
export const COUNT_SQL = `select table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int from information_schema.tables where table_schema in ('public', 'auth') and table_type = 'BASE TABLE' order by 1`;

/** 生成型の public schema から契約（table → column、view、function、enum → 値）を抜く。 */
export function extractSchemaContract(typesText) {
  const lines = typesText.split('\n');
  const start = lines.findIndex((line) => line === '  public: {');
  if (start === -1) throw new Error('public schema not found in generated types');
  const contract = { tables: new Map(), views: new Set(), functions: new Set(), enums: new Map() };
  let section = null;
  let entity = null;
  let inRow = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '  };') break;
    const sectionMatch = line.match(/^ {4}(Tables|Views|Functions|Enums|CompositeTypes): \{$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      entity = null;
      inRow = false;
      continue;
    }
    if (!section) continue;
    // `name: {` / `name: 'a' | 'b';` / 複数行 union の `name:`（行末）
    const entityMatch = line.match(/^ {6}(\w+):(?: (?:\{|'|")|\s*$)/);
    if (entityMatch && !/^\s*\[_ in never\]/.test(line)) {
      entity = entityMatch[1];
      inRow = false;
      if (section === 'Tables')
        contract.tables.set(entity, contract.tables.get(entity) ?? new Set());
      if (section === 'Views') contract.views.add(entity);
      if (section === 'Functions') contract.functions.add(entity);
      if (section === 'Enums') {
        const values = [...line.matchAll(/'([^']*)'/g)].map((match) => match[1]);
        // 複数行の union は次の行以降に続く
        let j = i + 1;
        while (!/;\s*$/.test(lines[j - 1]) && j < lines.length) {
          values.push(...[...lines[j].matchAll(/'([^']*)'/g)].map((match) => match[1]));
          j += 1;
        }
        contract.enums.set(entity, new Set(values));
      }
      continue;
    }
    if (section === 'Tables' && entity) {
      if (/^ {8}Row: \{$/.test(line)) {
        inRow = true;
        continue;
      }
      if (inRow && /^ {8}\};$/.test(line)) {
        inRow = false;
        continue;
      }
      const column = inRow && line.match(/^ {10}(\w+)\??: /);
      if (column) contract.tables.get(entity).add(column[1]);
    }
  }
  return contract;
}

/** base 契約に対して candidate で消えたもの（narrowing）。追加は互換なので数えない。 */
export function compareSchemaContracts(base, candidate) {
  const removed = { tables: [], columns: [], views: [], functions: [], enumValues: [] };
  for (const [table, columns] of base.tables) {
    const next = candidate.tables.get(table);
    if (!next) {
      removed.tables.push(table);
      continue;
    }
    for (const column of columns) if (!next.has(column)) removed.columns.push(`${table}.${column}`);
  }
  for (const view of base.views) if (!candidate.views.has(view)) removed.views.push(view);
  for (const fn of base.functions) if (!candidate.functions.has(fn)) removed.functions.push(fn);
  for (const [name, values] of base.enums) {
    const next = candidate.enums.get(name);
    for (const value of values)
      if (!next || !next.has(value)) removed.enumValues.push(`${name}.${value}`);
  }
  const narrowing = Object.values(removed).some((list) => list.length > 0);
  return { narrowing, removed };
}

/**
 * base と candidate の migration ファイル集合から upgrade 計画を作る。
 * @param {{ base: string[], candidate: string[], changed: { status: string, path: string }[] }} input
 */
export function planDbUpgrade({ base, candidate, changed }) {
  const versionOf = (name) => name.match(MIGRATION_FILE)?.[1] ?? null;
  const baseVersions = base.map(versionOf).filter(Boolean).sort();
  const candidateSet = new Set(candidate);
  const added = candidate.filter((name) => !base.includes(name) && MIGRATION_FILE.test(name));
  const problems = [];
  for (const entry of changed) {
    const name = entry.path.replace(`${MIGRATIONS_DIR}/`, '');
    if (!MIGRATION_FILE.test(name) || entry.path.includes('/_archive/')) continue;
    if (entry.status === 'M')
      problems.push(`applied migration edited: ${name} (production will not re-run it)`);
    if (entry.status === 'D' || (entry.status === 'R' && !candidateSet.has(name)))
      problems.push(`applied migration removed: ${name} (production keeps its effects)`);
  }
  if (baseVersions.length === 0)
    problems.push('base migration set is empty; cannot establish a trusted baseline');
  return {
    status: problems.length > 0 ? 'fail' : added.length === 0 ? 'skip' : 'run',
    baseVersion: baseVersions.at(-1) ?? null,
    added,
    problems,
  };
}

/** `-At -F,` の count 出力を Map にする。 */
export function parseCounts(output) {
  const counts = new Map();
  for (const line of output.split('\n')) {
    const [name, value] = line.split(',');
    if (name && /^\d+$/.test(value ?? '')) counts.set(name, Number(value));
  }
  return counts;
}

/** upgrade 前後の行数比較。既存 table の減少だけを失敗にする（新 table・増加は互換）。 */
export function compareCounts(before, after) {
  const lost = [];
  for (const [table, count] of before) {
    const next = after.get(table);
    if (next === undefined) lost.push(`${table}: table missing after upgrade`);
    else if (next < count) lost.push(`${table}: ${count} → ${next} rows`);
  }
  return lost;
}

function defaultExec(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: 'postgres' },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${file} ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || '').slice(-2000)}`,
    );
  return result.stdout ?? '';
}

const PSQL = [
  '-h',
  '127.0.0.1',
  '-p',
  '54322',
  '-U',
  'postgres',
  '-d',
  'postgres',
  '-v',
  'ON_ERROR_STOP=1',
];

/**
 * @param {{ exec?: typeof defaultExec, readFile?: (path: string) => string, listMigrations?: () => string[],
 *   log?: (text: string) => void, summaryPath?: string | null, resultPath?: string | null }} deps
 */
export function runDbUpgradeCheck({
  exec = defaultExec,
  readFile = (path) => readFileSync(resolve(ROOT, path), 'utf8'),
  listMigrations = () =>
    readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((name) => MIGRATION_FILE.test(name)),
  log = (text) => console.log(text),
  summaryPath = process.env.GITHUB_STEP_SUMMARY ?? null,
  resultPath = process.env.DB_UPGRADE_RESULT_PATH ?? null,
} = {}) {
  const result = {
    job: DB_UPGRADE_JOB,
    status: 'fail',
    baseSha: null,
    baseVersion: null,
    added: [],
    problems: [],
    checks: {},
  };
  const finish = () => {
    const lines = [
      '## DB upgrade (shadow)',
      '',
      `Status: **${result.status}**; base \`${result.baseSha ?? 'n/a'}\` (version ${result.baseVersion ?? 'n/a'}); added: ${result.added.join(', ') || 'none'}`,
      ...Object.entries(result.checks).map(([name, check]) => `- ${name}: ${check}`),
      ...result.problems.map((problem) => `- ❌ ${problem}`),
      '',
      'Shadow only: this job is not a required check. Fresh-path evidence lives in 🧪 Integration Tests.',
    ];
    const summary = `${lines.join('\n')}\n`;
    log(summary);
    if (summaryPath) appendFileSync(summaryPath, summary);
    if (resultPath) writeFileSync(resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  // base = pull_request checkout（merge commit）の第 1 親。無ければ origin/main。
  let baseSha;
  try {
    baseSha = exec('git', ['rev-parse', '--verify', 'HEAD^1^{commit}']).trim();
    exec('git', ['rev-parse', '--verify', 'HEAD^2^{commit}']);
  } catch {
    try {
      baseSha = exec('git', ['rev-parse', '--verify', 'origin/main^{commit}']).trim();
    } catch {
      result.problems.push('base revision unavailable (need merge commit parents or origin/main)');
      return finish();
    }
  }
  result.baseSha = baseSha;
  const baseList = exec('git', ['ls-tree', '--name-only', baseSha, '--', `${MIGRATIONS_DIR}/`])
    .split('\n')
    .map((path) => path.replace(`${MIGRATIONS_DIR}/`, ''))
    .filter((name) => MIGRATION_FILE.test(name));
  const changed = exec('git', [
    'diff',
    '--name-status',
    '--no-renames',
    baseSha,
    'HEAD',
    '--',
    MIGRATIONS_DIR,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status: status.charAt(0), path };
    });
  const plan = planDbUpgrade({ base: baseList, candidate: listMigrations(), changed });
  result.baseVersion = plan.baseVersion;
  result.added = plan.added;
  result.problems.push(...plan.problems);
  if (plan.status === 'fail') return finish();
  if (plan.status === 'skip') {
    result.status = 'skip';
    result.checks.upgrade = 'no migration added by this PR';
    return finish();
  }
  try {
    // 1. base の migration 集合 + seed まで戻す（reset は config の seed を適用する）
    exec('supabase', ['db', 'reset', '--local', '--version', plan.baseVersion], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const before = parseCounts(exec('psql', [...PSQL, '-At', '-F,', '-c', COUNT_SQL]));
    // 2. candidate の migration だけを当てる（version 順に依存せず未適用を全部）
    exec('supabase', ['migration', 'up', '--local', '--include-all'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result.checks.upgrade = `applied ${plan.added.length} migration(s) on top of ${plan.baseVersion} + seed`;
    // 3. 既存データの保持
    const after = parseCounts(exec('psql', [...PSQL, '-At', '-F,', '-c', COUNT_SQL]));
    const lost = compareCounts(before, after);
    if (lost.length) result.problems.push(...lost.map((entry) => `seeded rows lost: ${entry}`));
    else result.checks.dataPreserved = `${before.size} table(s) kept their seeded rows`;
    // 4. RLS / GRANT snapshot は upgraded DB でも一致する
    exec('pnpm', ['rls:snapshot:check']);
    result.checks.rlsSnapshot = 'matches on the upgraded database';
    // 5. fresh（commit 済みの生成型 = integration job が fresh DB で検証）と upgraded の schema 一致
    const upgradedTypes = exec('pnpm', ['exec', 'prettier', '--stdin-filepath', TYPES_PATH], {
      input: exec('supabase', ['gen', 'types', 'typescript', '--local'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    });
    const freshTypes = readFile(TYPES_PATH);
    if (upgradedTypes !== freshTypes)
      result.problems.push(
        'upgraded schema differs from the fresh schema (generated types mismatch)',
      );
    else result.checks.freshEquivalence = 'generated types identical to the fresh database';
    // 6. old consumer: base 世代の型が参照するオブジェクトが残っている
    const baseTypes = exec('git', ['show', `${baseSha}:${TYPES_PATH}`]);
    const comparison = compareSchemaContracts(
      extractSchemaContract(baseTypes),
      extractSchemaContract(upgradedTypes),
    );
    if (comparison.narrowing) {
      const detail = Object.entries(comparison.removed)
        .filter(([, list]) => list.length)
        .map(([kind, list]) => `${kind}: ${list.join(', ')}`)
        .join('; ');
      result.problems.push(
        `old consumer contract narrowed (${detail}); the live build still targets the base schema. Requires expand → migrate → contract sequencing and explicit approval`,
      );
    } else
      result.checks.oldConsumer =
        'every table / column / view / function / enum value used by the base types still exists';
  } catch (error) {
    result.problems.push(error instanceof Error ? error.message : 'upgrade check failed');
  }
  result.status = result.problems.length === 0 ? 'pass' : 'fail';
  return finish();
}

if (isDirectExecution(import.meta.url)) {
  const result = runDbUpgradeCheck();
  if (result.status === 'fail') {
    for (const problem of result.problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
  }
}
