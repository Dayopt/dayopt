/**
 * scripts/ 配下のファイルを「誰が呼ぶか」で分類する参照解析ライブラリ。
 *
 * #2476（scripts/ 呼ばれ方別再編）の Phase A で作成。無参照 script の常設検出
 * （`scripts/__tests__/scripts-taxonomy.test.ts`、Phase C で有効化）が内部で
 * 使う判定ロジックをここへ集約し、判定ロジックとテストコードを分離する。
 *
 * 分類優先順位（最初に該当したもの、CLAUDE.md 由来ではなく issue #2476 本文
 * が定義する 6 分類）:
 *   1. root/apps/packages の package.json script エントリから呼ばれる -> tasks
 *   2. `.github/workflows/` から直接実行される -> ci
 *   3. `.husky/` または `.claude/settings.json` の hooks 設定から直接実行される -> hooks
 *      （#2479 で hooks 実体が `.claude/hooks/` から `scripts/hooks/` へ移動し、
 *      呼び出し元は settings.json の command path のみになった。`.claude/hooks/`
 *      配下に残る言及があれば従来どおり拾うが、判定の主経路は settings.json）
 *   4. `.agents/skills/` / CLAUDE.md / AGENTS.md が
 *      実行手順として指定する（エージェント直叩き） -> agent
 *      （#2479 で `.claude/rules/` は全廃し AGENTS.md へ一本化した。walkFiles は
 *      存在しないディレクトリに対して空配列を返すため、以前の `.claude/rules/`
 *      判定コードを残していても無害だが、判定の主経路ではなくなった）
 *   5. docs の手順書（runbook）からのみ参照される -> runbook
 *   6. 他 script から import されるだけ（直接実行なし） -> lib
 *   該当なし -> unreferenced
 *
 * **重要な制約（実測で判明した誤検知源、詳細は #2476 issue コメント参照）**:
 * - `.github/workflows/**` の `paths:` トリガー条件への言及は「実行呼び出し」
 *   ではない。`run:` ステップ等の実行コンテキストと区別できないため、この
 *   ライブラリは workflow ファイル内での言及を機械的に ci 判定へ倒す
 *   （path フィルタのみの言及を誤って ci 判定してしまうケースが実在した。
 *   #2483 の CI ファイル統合で該当していた具体例（旧 integration.yml の
 *   paths: にのみ現れていたファイル）は解消済みだが、同じ誤検知の型は
 *   `.github/workflows/**` に `paths:` を持つ job が残る限り再発しうる。
 *   個々の判定結果は人間 / AI が最終確認すること — このライブラリは
 *   一次スクリーニングであり、確定判定ではない）
 * - `.claude/hooks/**` 内のコメント・エラーメッセージでの言及も同様に
 *   「実行照合」と「利用ガイド文言」を区別できない
 * - 内部結合の強いサブディレクトリ（例: `scripts/boundaries/`,
 *   `scripts/tasks/env/`）は、ファイル単位の分類結果が
 *   ディレクトリ内でバラける場合がある。ディレクトリ全体を主エントリポイント
 *   の分類へ統一するかどうかは呼び出し側の判断に委ねる（本ライブラリは
 *   ファイル単位の生の判定結果のみを返す）
 */
import fs from 'node:fs';
import path from 'node:path';

export type ScriptCategory =
  'tasks' | 'ci' | 'hooks' | 'agent' | 'runbook' | 'lib' | 'unreferenced';

export interface PackageJsonEntry {
  pkgFile: string;
  name: string;
  command: string;
}

export interface ReferenceHits {
  /** `pkgFile#entryName` 形式 */
  pkg: string[];
  workflow: string[];
  husky: string[];
  claudeHook: string[];
  /** .claude/settings.json の hooks 設定からの参照（#2479 以降の hooks 実体の主な呼び出し元） */
  claudeSettings: string[];
  /** CLAUDE.md + AGENTS.md（#2479 以前は .claude/rules/** も含んでいたが全廃済み） */
  claudeRule: string[];
  claudeSkill: string[];
  docs: string[];
  importedBy: string[];
}

export interface ClassifiedScript {
  path: string;
  category: ScriptCategory;
  hits: ReferenceHits;
}

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  '.storybook-static',
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** dir 配下のファイルを再帰的に列挙する（IGNORE_DIRS を除外）。 */
export function walkFiles(repoRoot: string, dir: string, filterExt?: string[]): string[] {
  const out: string[] = [];
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return out;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, cur), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const rel = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(rel);
      } else if (ent.isFile()) {
        if (!filterExt || filterExt.some((e) => rel.endsWith(e))) out.push(rel);
      }
    }
  }
  return out.sort();
}

/** scripts/ 配下の非テスト script ファイル（.ts/.mjs/.cjs/.sh）を列挙する。 */
export function listNonTestScriptFiles(repoRoot: string, scriptsDir = 'scripts'): string[] {
  const all = walkFiles(repoRoot, scriptsDir, ['.ts', '.mjs', '.cjs', '.sh']);
  return all.filter((f) => !f.includes('__tests__') && !/\.test\.(ts|mjs|cjs)$/.test(f));
}

/** root + workspace(apps/*, packages/*) の package.json script エントリを列挙する。 */
export function collectPackageJsonEntries(repoRoot: string): PackageJsonEntry[] {
  const pkgFiles = [
    ...walkFiles(repoRoot, '.', ['package.json']).filter((f) => f === 'package.json'),
    ...walkFiles(repoRoot, 'apps', ['package.json']),
    ...walkFiles(repoRoot, 'packages', ['package.json']),
  ].filter((f) => !f.includes('node_modules'));

  const entries: PackageJsonEntry[] = [];
  for (const pkgFile of pkgFiles) {
    const json = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgFile), 'utf8'));
    for (const [name, command] of Object.entries<string>(json.scripts ?? {})) {
      entries.push({ pkgFile, name, command });
    }
  }
  return entries;
}

function commandReferencesFile(command: string, filePath: string): boolean {
  const base = path.basename(filePath);
  if (command.includes(filePath)) return true;
  const re = new RegExp(`(^|[/\\s"'])${escapeRegExp(base)}([/\\s"'.]|$)`);
  return re.test(command);
}

function fileContainsReference(
  repoRoot: string,
  file: string,
  base: string,
  relPath: string,
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  } catch {
    return false;
  }
  if (content.includes(relPath)) return true;
  const re = new RegExp(`(^|[/\\s"'\`])${escapeRegExp(base)}([/\\s"'\`.]|$)`, 'm');
  return re.test(content);
}

function scanGroup(repoRoot: string, files: string[], relPath: string, base: string): string[] {
  const hits: string[] = [];
  for (const f of files) {
    // 自己言及は「呼ばれている」ではない（findImporters と同じ扱い）。走査対象に
    // script 自身が入りうるのは hook launcher 群だけだが、そこで自分の basename を
    // コメントに書くと無条件に hooks 判定になってしまう。
    if (f === relPath) continue;
    if (fileContainsReference(repoRoot, f, base, relPath)) hits.push(f);
  }
  return hits;
}

/** 拡張子なし import を含む import グラフを解決し、`relPath` を import している script のリストを返す。 */
function findImporters(repoRoot: string, allScriptFiles: string[], relPath: string): string[] {
  const baseNoExt = path.basename(relPath).replace(/\.(ts|mjs|cjs|sh)$/, '');
  const importers: string[] = [];
  for (const other of allScriptFiles) {
    if (other === relPath) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoRoot, other), 'utf8');
    } catch {
      continue;
    }
    const importRe = new RegExp(
      `(from|require\\()\\s*['"\`][^'"\`]*/${escapeRegExp(baseNoExt)}(\\.(ts|mjs|cjs|js))?['"\`]`,
    );
    if (importRe.test(content)) importers.push(other);
  }
  return importers;
}

export interface ScanContext {
  repoRoot: string;
  allScriptFiles: string[];
  pkgEntries: PackageJsonEntry[];
  workflowFiles: string[];
  huskyFiles: string[];
  claudeHookFiles: string[];
  claudeSettingsFiles: string[];
  /** hook 登録から直接起動される `scripts/hooks/` 配下の launcher（#2565） */
  hookLauncherFiles: string[];
  claudeRuleFiles: string[];
  claudeSkillFiles: string[];
  docsFiles: string[];
}

const HOOKS_DIR_PREFIX = 'scripts/hooks/';

/**
 * hook 登録（husky / `.claude/hooks/` / `.claude/settings.json`）から**直接**起動される
 * `scripts/hooks/` 配下の script（launcher）を返す。
 *
 * launcher が同じディレクトリの別 script を呼ぶ形（#2565 の `pre-tool-guard.sh` →
 * `pre-tool-guard.mjs`）では、呼ばれる側は settings.json に名前が出ないため hooks 判定
 * から落ちる。launcher 自身を hook 登録の延長として扱い、**`scripts/hooks/` 配下へ 1 段だけ**
 * 伝播させる。
 *
 * 範囲を `scripts/hooks/` に閉じるのは、launcher が import する汎用 lib
 * （`scripts/lib/is-direct-execution.mjs` 等）まで hooks 判定へ引きずられるため。
 * このライブラリは実行呼び出しと import を区別できない（冒頭の制約を参照）ので、
 * 伝播させてよい範囲をディレクトリで縛る。
 */
function collectHookLauncherFiles(
  repoRoot: string,
  allScriptFiles: string[],
  registrationFiles: string[],
): string[] {
  return allScriptFiles
    .filter((relPath) => relPath.startsWith(HOOKS_DIR_PREFIX))
    .filter(
      (relPath) =>
        scanGroup(repoRoot, registrationFiles, relPath, path.basename(relPath)).length > 0,
    );
}

/** 参照解析に使う全ファイルリストを一度だけ集める（複数 script の分類で使い回す）。 */
export function buildScanContext(repoRoot: string, scriptsDir = 'scripts'): ScanContext {
  const allScriptFiles = listNonTestScriptFiles(repoRoot, scriptsDir);
  const huskyFiles = walkFiles(repoRoot, '.husky');
  const claudeHookFiles = walkFiles(repoRoot, '.claude/hooks');
  const settingsFiles = ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml'].filter(
    (file) => fs.existsSync(path.join(repoRoot, file)),
  );
  const hookLauncherFiles = collectHookLauncherFiles(repoRoot, allScriptFiles, [
    ...huskyFiles,
    ...claudeHookFiles,
    ...settingsFiles,
  ]);

  return {
    repoRoot,
    allScriptFiles,
    pkgEntries: collectPackageJsonEntries(repoRoot),
    workflowFiles: walkFiles(repoRoot, '.github/workflows'),
    huskyFiles,
    claudeHookFiles,
    claudeSettingsFiles: settingsFiles,
    hookLauncherFiles,
    claudeRuleFiles: ['CLAUDE.md', 'AGENTS.md'].filter((f) =>
      fs.existsSync(path.join(repoRoot, f)),
    ),
    claudeSkillFiles: walkFiles(
      repoRoot,
      fs.existsSync(path.join(repoRoot, '.agents/skills')) ? '.agents/skills' : '.claude/skills',
    ),
    // JSON 等の棚卸し・検証データに含まれる path は実行手順ではない。
    docsFiles: walkFiles(repoRoot, 'docs', ['.md', '.mdx']),
  };
}

/** 1 ファイル分の参照ヒットを集める。 */
export function collectReferenceHits(ctx: ScanContext, relPath: string): ReferenceHits {
  const base = path.basename(relPath);
  return {
    pkg: ctx.pkgEntries
      .filter((e) => commandReferencesFile(e.command, relPath))
      .map((e) => `${e.pkgFile}#${e.name}`),
    workflow: scanGroup(ctx.repoRoot, ctx.workflowFiles, relPath, base),
    husky: scanGroup(ctx.repoRoot, ctx.huskyFiles, relPath, base),
    claudeHook: scanGroup(ctx.repoRoot, ctx.claudeHookFiles, relPath, base),
    claudeSettings: [
      ...scanGroup(ctx.repoRoot, ctx.claudeSettingsFiles, relPath, base),
      // launcher からの伝播は `scripts/hooks/` 配下にだけ効かせる（#2565）
      ...(relPath.startsWith(HOOKS_DIR_PREFIX)
        ? scanGroup(ctx.repoRoot, ctx.hookLauncherFiles, relPath, base)
        : []),
    ],
    claudeRule: scanGroup(ctx.repoRoot, ctx.claudeRuleFiles, relPath, base),
    claudeSkill: scanGroup(ctx.repoRoot, ctx.claudeSkillFiles, relPath, base),
    docs: scanGroup(ctx.repoRoot, ctx.docsFiles, relPath, base),
    importedBy: findImporters(ctx.repoRoot, ctx.allScriptFiles, relPath),
  };
}

/** 参照ヒットから優先順位に沿って 1 カテゴリを決定する。 */
export function classifyHits(hits: ReferenceHits): ScriptCategory {
  if (hits.pkg.length > 0) return 'tasks';
  if (hits.workflow.length > 0) return 'ci';
  if (hits.husky.length > 0 || hits.claudeHook.length > 0 || hits.claudeSettings.length > 0)
    return 'hooks';
  if (hits.claudeRule.length > 0 || hits.claudeSkill.length > 0) return 'agent';
  if (hits.docs.length > 0) return 'runbook';
  if (hits.importedBy.length > 0) return 'lib';
  return 'unreferenced';
}

/** scripts/ 配下の非テスト script 全件を分類する。 */
export function classifyAllScripts(repoRoot: string, scriptsDir = 'scripts'): ClassifiedScript[] {
  const ctx = buildScanContext(repoRoot, scriptsDir);
  return ctx.allScriptFiles.map((relPath) => {
    const hits = collectReferenceHits(ctx, relPath);
    return { path: relPath, category: classifyHits(hits), hits };
  });
}
