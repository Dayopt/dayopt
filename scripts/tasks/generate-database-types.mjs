import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = 'apps/product/src/lib/database/generated/database.types.ts';
const PRODUCTION_REF = 'yvglwblxrnrenfifsnje';
const USAGE =
  'Usage: pnpm types:generate --target local|production|preview|integration [--project-ref <ref>]';

export function parseTarget(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (i === 0 && flag === '--') continue;
    if (!['--target', '--project-ref'].includes(flag) || values.has(flag) || !args[i + 1])
      throw new Error(USAGE);
    values.set(flag, args[++i]);
  }
  const target = values.get('--target');
  const ref = values.get('--project-ref');
  if (!['local', 'production', 'preview', 'integration'].includes(target)) throw new Error(USAGE);
  if (target === 'local' || target === 'production') {
    if (ref) throw new Error('local/production は project-ref を受け取りません。');
    return { target, projectRef: target === 'production' ? PRODUCTION_REF : null };
  }
  if (!ref || !/^[a-z]{20}$/.test(ref) || ref === PRODUCTION_REF)
    throw new Error('非本番の project-ref を明示してください。本番への fallback はありません。');
  return { target, projectRef: ref };
}

/** @param {{args: string[], root?: string, run?: (command: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string}} options */
export async function generateDatabaseTypes({ args, root = ROOT, run = execFileSync }) {
  const identity = parseTarget(args);
  const flags = identity.projectRef ? ['--project-id', identity.projectRef] : ['--local'];
  let source;
  try {
    source = run('supabase', ['gen', 'types', '--lang', 'typescript', ...flags], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // CLI stderr は資格情報や接続文字列を含み得る。元ファイルと秘密情報を保護する。
    throw new Error('Supabase型生成に失敗しました。対象ref・CLI認証・接続を確認してください。');
  }
  if (typeof source !== 'string' || !/export\s+(?:type|interface)\s+Database\b/.test(source))
    throw new Error('Database型が取得できませんでした。生成済みファイルは保持します。');

  const output = join(root, OUTPUT);
  let formatted;
  try {
    formatted = await format(source, { ...(await resolveConfig(output)), filepath: output });
  } catch {
    throw new Error('生成結果を整形できませんでした。生成済みファイルは保持します。');
  }
  if (formatted === readFileSync(output, 'utf8')) return { ...identity, changed: false };

  // 同一filesystemでrenameし、生成・整形の失敗では既存型を切り詰めない。
  const temporary = mkdtempSync(join(dirname(output), '.types-'));
  try {
    const candidate = join(temporary, 'database.types.ts');
    writeFileSync(candidate, formatted);
    renameSync(candidate, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { ...identity, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await generateDatabaseTypes({ args: process.argv.slice(2) })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
