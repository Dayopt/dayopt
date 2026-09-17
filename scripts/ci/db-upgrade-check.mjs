#!/usr/bin/env node
/**
 * DB upgrade / old-consumer check（#2797）。ci.yml の `🧱 DB Upgrade (shadow)` job から実行する。
 *
 * integration job の `supabase start` は candidate の migration 集合を空 DB へ適用する
 * **fresh 経路**しか証明しない。ここでは次を別々に証明する:
 *
 * 1. upgrade: base（PR の merge 元）の migration 集合 + seed（合成データ）まで reset し、
 *    PR が追加した migration だけを `migration up --include-all` で当てる。適用エラー、
 *    seed 行の消失（既存データ保持）、fresh と upgraded の schema 不一致（`gen types` の差と
 *    index / constraint / trigger の catalog の差）を落とす。追加分は timestamp に関わらず
 *    reset から退避し、seed 済みの base に当てる経路だけを通す
 * 2. old consumer: base 世代の生成型（`database.types.ts`）が参照する table / column（型・
 *    nullability・Insert / Update の必須性）/ view /
 *    function / enum 値が upgraded DB から消えていれば「旧アプリ × 新 DB」の互換性が
 *    壊れる候補として落とす（expand → migrate → contract の contract 段は明示承認の対象）
 * 3. 適用済み migration の編集・削除は production が再実行しないため落とす
 *
 * PR が migration を追加していなければ skip（exit 0）。fresh 成功を upgrade 成功の代用にしない。
 * 接続先はローカル Docker の Supabase だけ（production / linked には触れない）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TYPES_PATH = 'apps/product/src/lib/database/generated/database.types.ts';
export const MIGRATIONS_DIR = 'supabase/migrations';
/** reset が投入する seed（config.toml の [db.seed].sql_paths）。base 側の内容で baseline を作る。 */
export const SEED_PATH = 'supabase/seed.sql';
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
export const DB_UPGRADE_JOB = '🧱 DB Upgrade (shadow)';

/** 既存データ・catalog を見る schema。app が所有する private（trigger 経由の control rows）も含める。 */
export const DATA_SCHEMAS = ['public', 'auth', 'private'];
const SCHEMA_LIST = DATA_SCHEMAS.map((name) => `'${name}'`).join(', ');

/** `information_schema` の全 base table の行数（DATA_SCHEMAS）。psql `-At -F,` で読む。 */
export const COUNT_SQL = `select table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int from information_schema.tables where table_schema in (${SCHEMA_LIST}) and table_type = 'BASE TABLE' order by 1`;

/** primary key を持つ table とその列（`schema.table,col1|col2`）。行の同一性比較に使う。 */
export const PK_SQL = `select tc.table_schema || '.' || tc.table_name, string_agg(kcu.column_name, '|' order by kcu.ordinal_position) from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema and kcu.table_name = tc.table_name where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema in (${SCHEMA_LIST}) group by 1 order by 1`;

/** `-At` の PK 一覧を Map<schema.table, string[]> にする。 */
export function parsePrimaryKeys(output) {
  const keys = new Map();
  for (const line of output.split('\n')) {
    const [table, columns] = line.split(',');
    if (table && columns) keys.set(table, columns.split('|'));
  }
  return keys;
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (text) => `'${text.replace(/'/g, "''")}'`;

/**
 * 各 table の主キー値を `schema.table,(v1,v2)` の行で列挙する SQL。upgrade 前の行が upgrade 後にも
 * 同じ主キーで残ることを見る（同数の入れ替え・作り直しは count では見えない）。
 */
export function rowIdentitySql(primaryKeys) {
  const selects = [];
  for (const [table, columns] of primaryKeys) {
    const [schema, name] = table.split('.');
    const pk = columns.map(quoteIdent).join(', ');
    selects.push(
      `select ${quoteLiteral(table)} || ',' || row(${pk})::text from ${quoteIdent(schema)}.${quoteIdent(name)}`,
    );
  }
  return selects.length ? `${selects.join(' union all ')} order by 1` : 'select null where false';
}

/** upgrade 前の主キー集合 ⊆ upgrade 後。消えた行を table ごとに数える。 */
export function compareRowIdentity(before, after) {
  const afterSet = new Set(after.split('\n').filter(Boolean));
  const missing = new Map();
  for (const line of before.split('\n').filter(Boolean)) {
    if (afterSet.has(line)) continue;
    const table = line.slice(0, line.indexOf(','));
    const entry = missing.get(table) ?? { count: 0, sample: line.slice(table.length + 1) };
    entry.count += 1;
    missing.set(table, entry);
  }
  return [...missing].map(
    ([table, entry]) =>
      `${table}: ${entry.count} seeded row(s) no longer present by primary key (e.g. ${entry.sample})`,
  );
}

/**
 * DATA_SCHEMAS の index / constraint / 非 internal trigger の catalog snapshot（生成型に現れない
 * schema。auth.users 上の custom trigger も含む）。fresh と upgraded で同じ文字列になることを要求する。
 */
export const CATALOG_SQL = `select 'index:' || schemaname || '.' || indexname || ' ' || indexdef from pg_indexes where schemaname in (${SCHEMA_LIST}) union all select 'constraint:' || n.nspname || '.' || c.conrelid::regclass::text || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in (${SCHEMA_LIST}) union all select 'trigger:' || n.nspname || '.' || t.tgrelid::regclass::text || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname in (${SCHEMA_LIST}) and not t.tgisinternal order by 1`;

/**
 * Functions の 1 entity（`      name: {` の次行から `      };` の前まで）を Args / Returns に分ける。
 * 単一 signature だけ構造化し、overload（Args が複数）や読めない形は raw 比較に落とす。
 */
function parseFunctionBlock(blockLines) {
  const raw = blockLines.join(' ').replace(/\s+/g, ' ').trim();
  const argsIndexes = blockLines
    .map((line, i) => (/^ {8}Args:/.test(line) ? i : -1))
    .filter((i) => i >= 0);
  const returnsIndex = blockLines.findIndex((line) => /^ {8}Returns:/.test(line));
  if (argsIndexes.length !== 1 || returnsIndex === -1) return { raw, args: null, returns: null };
  const args = new Map();
  const argsLine = blockLines[argsIndexes[0]];
  const inline = argsLine.match(/^ {8}Args: \{ ?(.*?) ?\};$/);
  if (inline) {
    for (const entry of inline[1].split(';')) {
      const match = entry.trim().match(/^(\w+)(\?)?: (.+)$/);
      if (match) args.set(match[1], { type: match[3], optional: match[2] === '?' });
    }
  } else if (/^ {8}Args: \{$/.test(argsLine)) {
    for (
      let j = argsIndexes[0] + 1;
      j < blockLines.length && !/^ {8}\};$/.test(blockLines[j]);
      j += 1
    ) {
      const match = blockLines[j].match(/^ {10}(\w+)(\?)?: (.+);$/);
      if (match) args.set(match[1], { type: match[3], optional: match[2] === '?' });
    }
  } else if (!/^ {8}Args: (never|Record<PropertyKey, never>);$/.test(argsLine)) {
    return { raw, args: null, returns: null };
  }
  const returns = blockLines
    .slice(returnsIndex)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^ ?Returns: /, '')
    .replace(/;$/, '')
    .trim();
  return { raw, args, returns };
}

/**
 * 生成型の public schema から契約を抜く。table は Row の列 → 型、Insert / Update の列 →
 * { type, optional }（旧アプリの読み書き契約）、view は Row の列 → 型、function は
 * Args（名前 → { type, optional }）と Returns、enum → 値。
 */
export function extractSchemaContract(typesText) {
  const lines = typesText.split('\n');
  const start = lines.findIndex((line) => line === '  public: {');
  if (start === -1) throw new Error('public schema not found in generated types');
  const contract = { tables: new Map(), views: new Map(), functions: new Map(), enums: new Map() };
  let section = null;
  let entity = null;
  /** @type {'Row' | 'Insert' | 'Update' | null} */
  let block = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '  };') break;
    const sectionMatch = line.match(/^ {4}(Tables|Views|Functions|Enums|CompositeTypes): \{$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      entity = null;
      block = null;
      continue;
    }
    if (!section) continue;
    // `name: {` / `name: 'a' | 'b';` / 複数行 union の `name:`（行末）
    const entityMatch = line.match(/^ {6}(\w+):(?: (?:\{|'|")|\s*$)/);
    if (entityMatch && !/^\s*\[_ in never\]/.test(line)) {
      entity = entityMatch[1];
      block = null;
      if (section === 'Tables')
        contract.tables.set(
          entity,
          contract.tables.get(entity) ?? {
            columns: new Map(),
            insert: new Map(),
            update: new Map(),
            relationships: new Set(),
          },
        );
      if (section === 'Views') contract.views.set(entity, { columns: new Map() });
      if (section === 'Functions') {
        // 1 行形式 `name: { Args: {...}; Returns: T };` は Args / Returns の 2 行に展開する
        const inline = line.match(/^ {6}\w+: \{ (Args: .*); (Returns: .*) \};$/);
        if (inline) {
          contract.functions.set(
            entity,
            parseFunctionBlock([`        ${inline[1]};`, `        ${inline[2]};`]),
          );
          continue;
        }
        const block = [];
        let j = i + 1;
        // entity の閉じ `      };` か section の境界（4 space 始まり）で止める
        while (j < lines.length && !/^ {6}\};$/.test(lines[j]) && !/^ {4}\S/.test(lines[j]))
          block.push(lines[j++]);
        contract.functions.set(entity, parseFunctionBlock(block));
        i = j;
      }
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
    if (section === 'Tables' && entity && /^ {8}Relationships: \[$/.test(line)) {
      // `{ foreignKeyName; columns; isOneToOne; referencedRelation; referencedColumns }` を 1 件ずつ
      // 正規化した文字列にする（旧 build の embedded relation 問い合わせが解決できる契約）
      let j = i + 1;
      let current = [];
      while (j < lines.length && !/^ {8}\];$/.test(lines[j])) {
        const text = lines[j].trim();
        if (text === '{') current = [];
        else if (text === '},' || text === '}')
          contract.tables.get(entity).relationships.add(current.join(' '));
        else current.push(text);
        j += 1;
      }
      i = j;
      continue;
    }
    if ((section === 'Tables' || section === 'Views') && entity) {
      const blockMatch = line.match(/^ {8}(Row|Insert|Update): \{$/);
      if (blockMatch) {
        block = /** @type {'Row' | 'Insert' | 'Update'} */ (blockMatch[1]);
        continue;
      }
      if (block && /^ {8}\};$/.test(line)) {
        block = null;
        continue;
      }
      // 型は行末の `;` まで（複数行 union は生成型の Row / Insert / Update には現れない）
      const column = block && line.match(/^ {10}(\w+)(\?)?: (.+);$/);
      if (column && section === 'Views') {
        if (block === 'Row') contract.views.get(entity).columns.set(column[1], column[3]);
      } else if (column) {
        const table = contract.tables.get(entity);
        if (block === 'Row') table.columns.set(column[1], column[3]);
        else
          table[block === 'Insert' ? 'insert' : 'update'].set(column[1], {
            type: column[3],
            optional: column[2] === '?',
          });
      }
    }
  }
  return contract;
}

/**
 * base 契約に対して candidate で消えた・変わったもの（narrowing）。object の追加は互換なので
 * 数えないが、Insert に **必須**の列が増えるのは旧アプリの insert を壊すので数える。
 * Row の型変更（`text` → `integer`、nullable 化）は旧アプリの読み取りを、Insert / Update の
 * 型変更と optional → required は旧アプリの書き込みを壊し得るので、どちらも narrowing。
 */
export function compareSchemaContracts(base, candidate) {
  const removed = {
    tables: [],
    columns: [],
    columnTypes: [],
    writeContracts: [],
    relationships: [],
    views: [],
    viewColumns: [],
    functions: [],
    functionSignatures: [],
    enumValues: [],
  };
  for (const [table, contract] of base.tables) {
    const next = candidate.tables.get(table);
    if (!next) {
      removed.tables.push(table);
      continue;
    }
    for (const [column, type] of contract.columns) {
      const nextType = next.columns.get(column);
      if (nextType === undefined) removed.columns.push(`${table}.${column}`);
      else if (nextType !== type)
        removed.columnTypes.push(`${table}.${column}: ${type} → ${nextType}`);
    }
    for (const kind of /** @type {const} */ (['insert', 'update'])) {
      for (const [column, spec] of contract[kind]) {
        const nextSpec = next[kind].get(column);
        if (!nextSpec) {
          // Row に残っていても書き込みから消えた列（generated / read-only 化）は旧 writer を壊す。
          // Row からも消えた列は columns 側で数える
          if (next.columns.has(column))
            removed.writeContracts.push(`${table}.${column} (${kind}): no longer writable`);
          continue;
        }
        if (nextSpec.type !== spec.type)
          removed.writeContracts.push(
            `${table}.${column} (${kind}): ${spec.type} → ${nextSpec.type}`,
          );
        else if (spec.optional && !nextSpec.optional)
          removed.writeContracts.push(`${table}.${column} (${kind}): optional → required`);
      }
    }
    for (const [column, spec] of next.insert)
      if (!contract.insert.has(column) && !spec.optional)
        removed.writeContracts.push(
          `${table}.${column} (insert): new required column (old writers omit it)`,
        );
    for (const relationship of contract.relationships)
      if (!next.relationships.has(relationship))
        removed.relationships.push(`${table}: ${relationship}`);
  }
  for (const [view, contract] of base.views) {
    const next = candidate.views.get(view);
    if (!next) {
      removed.views.push(view);
      continue;
    }
    for (const [column, type] of contract.columns) {
      const nextType = next.columns.get(column);
      if (nextType === undefined) removed.viewColumns.push(`${view}.${column}`);
      else if (nextType !== type)
        removed.viewColumns.push(`${view}.${column}: ${type} → ${nextType}`);
    }
  }
  for (const [fn, contract] of base.functions) {
    const next = candidate.functions.get(fn);
    if (!next) {
      removed.functions.push(fn);
      continue;
    }
    if (!contract.args || !next.args) {
      if (contract.raw !== next.raw) removed.functionSignatures.push(`${fn}: signature changed`);
      continue;
    }
    for (const [arg, spec] of contract.args) {
      const nextSpec = next.args.get(arg);
      if (!nextSpec) removed.functionSignatures.push(`${fn}(${arg}): argument removed`);
      else if (nextSpec.type !== spec.type)
        removed.functionSignatures.push(`${fn}(${arg}): ${spec.type} → ${nextSpec.type}`);
      else if (spec.optional && !nextSpec.optional)
        removed.functionSignatures.push(`${fn}(${arg}): optional → required`);
    }
    for (const [arg, spec] of next.args)
      if (!contract.args.has(arg) && !spec.optional)
        removed.functionSignatures.push(
          `${fn}(${arg}): new required argument (old callers omit it)`,
        );
    if (contract.returns !== next.returns)
      removed.functionSignatures.push(`${fn}: returns ${contract.returns} → ${next.returns}`);
  }
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
 * baseline reset の間だけ入力を base 側に揃えて fn を実行し、必ず戻す:
 * - PR が追加した migration を `supabase/migrations` から退避する。`db reset --version` は現在の
 *   checkout にある version 以下のファイルを全部当てるので、base の最新より古い timestamp の
 *   追加分が seed より前（= 既存データの無い経路）に混ざる
 * - `supabase/seed.sql` を base SHA の内容に差し替える。candidate の seed から旧形式の行を消した
 *   PR は、そのままだと「旧データに当てる」経路を通らない
 * 戻した後の `migration up` と fresh reset は candidate の入力で走る。
 */
function withBaseInputs({ added, baseSeed }, { moveFile, makeTempDir, readFile, writeFile }, fn) {
  const stash = makeTempDir();
  const moved = [];
  const candidateSeed = readFile(SEED_PATH);
  try {
    for (const name of added) {
      moveFile(resolve(ROOT, MIGRATIONS_DIR, name), resolve(stash, name));
      moved.push(name);
    }
    writeFile(SEED_PATH, baseSeed);
    return fn();
  } finally {
    writeFile(SEED_PATH, candidateSeed);
    for (const name of moved) moveFile(resolve(stash, name), resolve(ROOT, MIGRATIONS_DIR, name));
  }
}

/**
 * @param {{ exec?: typeof defaultExec, readFile?: (path: string) => string, listMigrations?: () => string[],
 *   writeFile?: (path: string, text: string) => void,
 *   moveFile?: (from: string, to: string) => void, makeTempDir?: () => string,
 *   log?: (text: string) => void, summaryPath?: string | null, resultPath?: string | null }} deps
 */
export function runDbUpgradeCheck({
  exec = defaultExec,
  readFile = (path) => readFileSync(resolve(ROOT, path), 'utf8'),
  writeFile = (path, text) => writeFileSync(resolve(ROOT, path), text),
  listMigrations = () =>
    readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((name) => MIGRATION_FILE.test(name)),
  moveFile = renameSync,
  makeTempDir = () => mkdtempSync(resolve(tmpdir(), 'db-upgrade-added-')),
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
    // 1. base の migration 集合 + base の seed まで戻す（reset は config の seed を適用する）。
    //    追加分は timestamp に関わらず退避し、production と同じ「既存データに当てる」経路だけを通す
    const baseSeed = exec('git', ['show', `${baseSha}:${SEED_PATH}`]);
    withBaseInputs(
      { added: plan.added, baseSeed },
      { moveFile, makeTempDir, readFile, writeFile },
      () => exec('supabase', ['db', 'reset', '--local'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    const before = parseCounts(exec('psql', [...PSQL, '-At', '-F,', '-c', COUNT_SQL]));
    const primaryKeys = parsePrimaryKeys(exec('psql', [...PSQL, '-At', '-F,', '-c', PK_SQL]));
    const identitySql = rowIdentitySql(primaryKeys);
    const beforeRows = exec('psql', [...PSQL, '-At', '-c', identitySql]);
    // 2. candidate の migration だけを当てる（version 順に依存せず未適用を全部）
    exec('supabase', ['migration', 'up', '--local', '--include-all'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result.checks.upgrade = `applied ${plan.added.length} migration(s) on top of ${plan.baseVersion} + seed`;
    // 3. 既存データの保持
    const after = parseCounts(exec('psql', [...PSQL, '-At', '-F,', '-c', COUNT_SQL]));
    const afterRows = exec('psql', [...PSQL, '-At', '-c', identitySql]);
    const lost = [...compareCounts(before, after), ...compareRowIdentity(beforeRows, afterRows)];
    if (lost.length) result.problems.push(...lost.map((entry) => `seeded rows lost: ${entry}`));
    else
      result.checks.dataPreserved = `${before.size} table(s) kept their seeded rows (count and primary-key identity across ${primaryKeys.size} keyed table(s))`;
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
        'every table / column (type, nullability, writability) / relationship / view column / function signature / enum value used by the base types still exists';
    // 7. 生成型に現れない schema（index / constraint / trigger）も fresh と一致する。既存行の有無で
    //    分岐する migration は fresh と upgraded で違う catalog を作り得るので、ここで fresh を
    //    作り直して catalog を比較する（追加分は戻してあるので reset = candidate 全部）
    const upgradedCatalog = exec('psql', [...PSQL, '-At', '-c', CATALOG_SQL]);
    exec('supabase', ['db', 'reset', '--local'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const freshCatalog = exec('psql', [...PSQL, '-At', '-c', CATALOG_SQL]);
    if (upgradedCatalog !== freshCatalog) {
      const upgradedSet = new Set(upgradedCatalog.split('\n'));
      const freshSet = new Set(freshCatalog.split('\n'));
      const onlyUpgraded = [...upgradedSet].filter((line) => line && !freshSet.has(line));
      const onlyFresh = [...freshSet].filter((line) => line && !upgradedSet.has(line));
      result.problems.push(
        `upgraded catalog differs from the fresh catalog (only after upgrade: ${onlyUpgraded.join(' | ') || 'none'}; only in fresh: ${onlyFresh.join(' | ') || 'none'})`,
      );
    } else
      result.checks.catalogEquivalence =
        'indexes / constraints / triggers identical to the fresh database';
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
