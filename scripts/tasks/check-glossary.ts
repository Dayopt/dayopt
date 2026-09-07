#!/usr/bin/env node

/**
 * copy:check — Copy System 禁止表記スキャナー
 *
 * 禁止語の定義は `scripts/lib/glossary/terms.ts`（用語集レジストリ）が正本で、
 * `docs/product/glossary.md` の表も同じデータから生成される。このスクリプトは
 * messages を読んでレジストリの規則を当てるだけの薄い CLI。
 *
 * 旧実装は「glossary.md と同期」とコメントしながら TypeScript 定数を手で持って
 * おり、実際にはずれていた（禁止語「エントリ」が未登録、`タスク` の推奨語が
 * 禁止語「エントリ」、既に存在しない tags.json の除外設定）。正本を 1 つにして
 * ずれ自体を無くす。
 *
 * 動作モード:
 *   - デフォルト: 警告のみ (exit 0)
 *   - --strict: enforcement: 'active' の違反があれば exit 1
 *     （`pnpm check:static` に `pnpm copy:check:strict` として配線済み）
 *
 * スキャン対象は `apps/product/messages/{ja,en}`。LP（apps/web）は語彙ドメインが
 * 別（ブログ / docs のタグ分類など）のため対象外で、語彙統一は手動レビューで
 * 担保する（docs/product/glossary.md の詳細ノート参照、2026-08-18 確定）。
 *
 * Usage:
 *   pnpm copy:check
 *   pnpm copy:check:strict
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildValueRules,
  compileKeyNameRules,
  getAllStringValues,
  scanKeyNames,
  scanValues,
  validateRegistry,
  type KeyNameFinding,
  type Locale,
  type MessageValue,
  type ValueFinding,
} from '../lib/glossary/core.ts';
import { GLOSSARY, KEY_NAME_RULES } from '../lib/glossary/terms.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const LOCALES: readonly Locale[] = ['ja', 'en'];
const messagesDirFor = (locale: Locale): string => resolve(ROOT, `apps/product/messages/${locale}`);

const STRICT_MODE = process.argv.includes('--strict');

// ─── レジストリ健全性（fail closed） ───

const registryProblems = validateRegistry(GLOSSARY, KEY_NAME_RULES);
if (registryProblems.length > 0) {
  console.error('❌ 用語集レジストリが不整合です（scripts/lib/glossary/terms.ts）:');
  for (const problem of registryProblems) console.error(`   - ${problem}`);
  process.exit(2);
}

// ─── メッセージ読み込み ───

function loadMessages(locale: Locale): MessageValue[] {
  const dir = messagesDirFor(locale);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const values: MessageValue[] = [];
  for (const file of files) {
    const namespace = basename(file, '.json');
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    for (const { keyPath, value } of getAllStringValues(data)) {
      values.push({ namespace, keyPath, value });
    }
  }
  return values;
}

const valueFindings: ValueFinding[] = [];
const keyFindings: KeyNameFinding[] = [];
const compiledKeyRules = compileKeyNameRules(KEY_NAME_RULES);

for (const locale of LOCALES) {
  const values = loadMessages(locale);
  valueFindings.push(...scanValues(values, buildValueRules(GLOSSARY, locale), locale));
  keyFindings.push(...scanKeyNames(values, compiledKeyRules, locale));
}

// ─── レポート出力 ───

const activeValueFindings = valueFindings.filter((f) => f.enforcement === 'active');
const migrationValueFindings = valueFindings.filter((f) => f.enforcement === 'migration');
const activeKeyFindings = keyFindings.filter((f) => f.enforcement === 'active');
const migrationKeyFindings = keyFindings.filter((f) => f.enforcement === 'migration');

const activeCount = activeValueFindings.length + activeKeyFindings.length;
const migrationCount = migrationValueFindings.length + migrationKeyFindings.length;

console.log('\n── copy:check ──────────────────────────────────────');

function messagePath(finding: { locale: Locale; namespace: string }): string {
  return relative(ROOT, join(messagesDirFor(finding.locale), `${finding.namespace}.json`));
}

interface TermSummaryRow {
  term: string;
  preferred: string;
  path: string;
}

/** 語ごとに件数とファイル数へ畳んで表示する（移行対象は件数が多く全列挙が読めないため） */
function summarize(label: string, rows: readonly TermSummaryRow[]): void {
  if (rows.length === 0) return;

  const byTerm = new Map<string, { count: number; files: Set<string>; preferred: string }>();
  for (const row of rows) {
    const bucket = byTerm.get(row.term) ?? { count: 0, files: new Set<string>(), preferred: '' };
    bucket.count += 1;
    bucket.files.add(row.path);
    bucket.preferred = row.preferred;
    byTerm.set(row.term, bucket);
  }

  console.log(`\n${label}`);
  for (const [term, bucket] of [...byTerm].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `   "${term}" → "${bucket.preferred}": ${bucket.count} 件 (${bucket.files.size} ファイル)`,
    );
  }
}

if (activeCount === 0 && migrationCount === 0) {
  console.log('✅ 禁止表記なし\n');
  process.exit(0);
}

if (activeValueFindings.length > 0) {
  console.log(`\n⚠️  禁止表記 (${activeValueFindings.length} 件):`);
  for (const finding of activeValueFindings) {
    console.log(`   ${messagePath(finding)}`);
    console.log(`     キー: ${finding.keyPath}`);
    console.log(`     値:   "${finding.value}"`);
    console.log(`     禁止: "${finding.term}" → 推奨: "${finding.preferred}"\n`);
  }
}

if (activeKeyFindings.length > 0) {
  console.log(`\n⚠️  禁止表記（キー名） (${activeKeyFindings.length} 件):`);
  for (const finding of activeKeyFindings) {
    console.log(`   ${messagePath(finding)}`);
    console.log(`     キー: ${finding.keyPath}`);
    console.log(`     禁止 token: "${finding.token}" → 推奨: "${finding.preferred}"\n`);
  }
}

summarize(
  'ℹ️  移行中（新規追加禁止、既存は移行 PR で対応）:',
  migrationValueFindings.map((f) => ({
    term: f.term,
    preferred: f.preferred,
    path: messagePath(f),
  })),
);
summarize(
  'ℹ️  移行中（キー名。値が正しくてもキーが旧語彙だと AI が再生産する）:',
  migrationKeyFindings.map((f) => ({
    term: f.token,
    preferred: f.preferred,
    path: messagePath(f),
  })),
);

console.log(`\n合計: ${activeCount} 件の禁止表記、${migrationCount} 件の移行対象`);
if (!STRICT_MODE) {
  console.log('(警告モード: --strict を付けると exit 1 になります)\n');
} else {
  console.log();
}

if (STRICT_MODE && activeCount > 0) {
  process.exit(1);
}
