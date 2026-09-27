import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT = resolve(__dirname, '../../..');
export const DOCS_DIR = resolve(ROOT, 'docs');

// status / last_verified が必須の stock domain。
// 2026-08-10: marketing ドメインは廃止し business へ統合したため削除
// （docs/marketing/* は git mv 済みで docs/business/* 配下に存在しない）。
export const STOCK_DIRS = ['business', 'product', 'engineering', 'operations', 'company', 'learn'];

// STOCK_DIRS はドメインサブディレクトリ単位で stock 契約を適用するための allowlist。
// docs ルート直下へ昇格した個別ファイルはドメインを持たないため、ここに明示する。
export const ROOT_STOCK_FILES = ['docs/strategy.md'];

// 手書きfrontmatterを付けないgenerated file。完全一致だけを例外にする。
// generated file ごとの表示契約: 冒頭に生成元 script・再生成 command・「手で編集しない」を必ず持つ
export const GENERATED_DOC_CONTRACTS: Record<string, { source: string; command: string }> = {
  'docs/engineering/data/db/rls-snapshot.md': {
    source: 'scripts/tasks/generate-rls-snapshot.ts',
    command: 'pnpm rls:snapshot',
  },
  'docs/engineering/data/architecture-inventory.md': {
    source: 'scripts/tasks/generate-architecture-map.ts',
    command: 'pnpm architecture:generate',
  },
  'docs/engineering/data/system-surface.md': {
    source: 'scripts/tasks/generate-architecture-map.ts',
    command: 'pnpm architecture:generate',
  },
};
export const GENERATED_DOCS = Object.keys(GENERATED_DOC_CONTRACTS);

export const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/** 存在する最初の base ref を返す（CI では origin/main、ローカルでは main にフォールバック）。 */
export function resolveBaseRef(): string {
  const candidates = [process.env.DOCS_GUARD_BASE_REF, 'origin/main', 'main'].filter(
    (v): v is string => Boolean(v),
  );

  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { cwd: ROOT, stdio: 'ignore' });
      return ref;
    } catch {
      continue;
    }
  }

  throw new Error('base ref (origin/main / main) が解決できません');
}

export function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf-8' });
}
